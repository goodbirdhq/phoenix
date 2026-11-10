import {
  SalesActionError,
  SalesAutopilotToday,
  type SalesAutopilotItem,
  type SalesCardState,
  type SalesResumeInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  type AutopilotCommands,
  autopilotActions,
  autopilotDetail,
  autopilotTimeline,
  batchConfirmText,
  outOfOfficeLabel,
  pauseSend,
  resumeSend,
  runBatch,
  type SalesBatchState,
  showsOnRowAfterBatch,
} from "./autopilot.ts";
import type { SalesHoldOutcome } from "./hold.ts";
import { detail } from "./fixtures/queueItemDetail.ts";

const decodeAutopilot = Schema.decodeUnknownSync(SalesAutopilotToday);

const autopilotItems = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<SalesAutopilotItem> =>
  decodeAutopilot({
    generatedAt: "2026-11-09T18:30:00.000Z",
    items: rows.map((row, index) => ({ activityId: `act-${index}`, ...row })),
  }).items;

describe("autopilotTimeline", () => {
  const items = autopilotItems([
    { state: "sent", approval: "route" },
    { state: "scheduled", approval: "press" },
    { state: "failed", approval: "route" },
    { state: "sent", approval: null },
    { state: "paused", approval: "route", paused: { by: "phoenix", at: "2026-11-09T17:00:00Z" } },
    { state: "held", approval: "route" },
    { state: "made-up-by-a-later-engine", approval: "route" },
  ]);

  it("shows automated sends only, and says how many pressed ones it left out", () => {
    const timeline = autopilotTimeline(items, false);
    expect(timeline.groups.map((group) => [group.label, group.items.length])).toEqual([
      ["Failed", 1],
      ["Held by the engine", 1],
      ["Paused", 1],
      ["Sent", 2],
      ["Other", 1],
    ]);
    expect(timeline).toMatchObject({ shown: 6, pressedHidden: 1 });
  });

  it("takes pressed sends in when asked", () => {
    const timeline = autopilotTimeline(items, true);
    expect(timeline.groups.map((group) => group.state)).toEqual([
      "failed",
      "held",
      "paused",
      "scheduled",
      "sent",
      "other",
    ]);
    expect(timeline).toMatchObject({ shown: 7, pressedHidden: 0 });
  });

  it("reads who paused a send, and an engine that sends no pause at all", () => {
    expect(items.find((item) => item.state === "paused")?.paused?.by).toBe("phoenix");
    expect(items.find((item) => item.state === "held")?.paused).toBeNull();
  });
});

describe("autopilot rows", () => {
  it("says which email, from where, and who approved it", () => {
    const [item] = autopilotItems([
      { state: "scheduled", approval: "press", step: 2, campaign: "Fintech Q4", mailbox: "g@x" },
    ]);
    expect(autopilotDetail(item!)).toBe("Email 2 · Fintech Q4 · from g@x · approved by you");
    const [bare] = autopilotItems([{ state: "scheduled", approval: "route" }]);
    expect(autopilotDetail(bare!)).toBe("");
  });

  it("names the day an out-of-office ends, when it gives one", () => {
    expect(outOfOfficeLabel({ returnOn: "2026-11-12", window: "", receivedAt: null })).toMatch(
      /^Away until Thu/,
    );
    expect(outOfOfficeLabel({ returnOn: null, window: "this week", receivedAt: null })).toBe(
      "Out of office",
    );
  });
});

const card = (patch: Partial<SalesCardState> = {}): SalesCardState => ({
  activityId: "act-1",
  contentHash: "a".repeat(64),
  state: "open",
  approved: false,
  approvedBy: null,
  sendAt: null,
  goes: null,
  refusal: null,
  note: null,
  paused: null,
  sendStatus: null,
  ...patch,
});

const engineRefused = <A>(reason: "chase_cap" | "needs_press"): AtomCommandResult<A, unknown> =>
  AsyncResult.failure(
    Cause.fail(
      new SalesActionError({
        origin: "engine",
        reason,
        message: "Refused.",
        currentHash: null,
        state: null,
      }),
    ),
  );

describe("autopilot actions", () => {
  it("pauses only a scheduled send the autopilot approved, and resumes a paused one", () => {
    expect(autopilotActions({ state: "scheduled", approval: "route" })).toEqual({
      pause: true,
      resume: false,
    });
    expect(autopilotActions({ state: "scheduled", approval: "press" }).pause).toBe(false);
    expect(autopilotActions({ state: "held", approval: "route" }).pause).toBe(false);
    expect(autopilotActions({ state: "sending", approval: "route" }).pause).toBe(false);
    expect(autopilotActions({ state: "paused", approval: "route" }).resume).toBe(true);
  });

  const commands = (overrides: Partial<AutopilotCommands>): AutopilotCommands => ({
    hold: async () => AsyncResult.success({ card: card(), already: false, result: "paused" }),
    resume: async () => AsyncResult.success({ card: card({ approved: true }), already: false }),
    getQueueItem: async () => AsyncResult.success({ ...detail(), state: "paused" }),
    ...overrides,
  });

  it("says a claimed send was already going, never that it stopped", async () => {
    const outcome = await pauseSend(
      commands({
        hold: async () =>
          AsyncResult.success({
            card: card({ sendStatus: "claimed" }),
            already: false,
            result: "paused",
          }),
      }),
      "act-1",
    );
    expect(outcome).toMatchObject({ kind: "going", tone: "warning", title: "Already going" });
  });

  it("tells a withdrawn approval apart from a pause", async () => {
    const outcome = await pauseSend(
      commands({
        hold: async () =>
          AsyncResult.success({ card: card(), already: false, result: "unapproved" }),
      }),
      "act-1",
    );
    expect(outcome).toMatchObject({ kind: "withdrawn", title: "Approval withdrawn" });
  });

  it("resumes the version the engine shows now", async () => {
    const asked: SalesResumeInput[] = [];
    const outcome = await resumeSend(
      commands({
        resume: async (input) => {
          asked.push(input);
          return AsyncResult.success({
            card: card({ approved: true, goes: "Tue 10 Nov, 09:14 their time" }),
            already: false,
          });
        },
      }),
      "act-1",
    );
    expect(asked).toEqual([{ activityId: "act-1", expectedHash: detail().contentHash }]);
    expect(outcome).toMatchObject({
      kind: "done",
      title: "Resumed",
      description: "It goes Tue 10 Nov, 09:14 their time.",
    });
  });

  it("leaves a send that is no longer paused alone", async () => {
    let resumed = false;
    const outcome = await resumeSend(
      commands({
        getQueueItem: async () => AsyncResult.success({ ...detail(), state: "sent" }),
        resume: async () => {
          resumed = true;
          return engineRefused("needs_press");
        },
      }),
      "act-1",
    );
    expect(resumed).toBe(false);
    expect(outcome).toMatchObject({ kind: "failed", title: "No longer paused" });
  });

  it("explains the day's cap and a resume that needs a press", async () => {
    const cap = await resumeSend(
      commands({ resume: async () => engineRefused("chase_cap") }),
      "act-1",
    );
    expect(cap).toMatchObject({ tone: "warning", needsPress: false });
    expect(cap.description).toMatch(/stays paused/);
    const press = await resumeSend(
      commands({ resume: async () => engineRefused("needs_press") }),
      "act-1",
    );
    expect(press).toMatchObject({ tone: "warning", needsPress: true });
  });

  it("never words Resume's already as Hold's already going", async () => {
    const resumed = await resumeSend(
      commands({
        resume: async () =>
          AsyncResult.success({ card: card({ goes: "Tue 10 Nov, 09:14" }), already: true }),
      }),
      "act-1",
    );
    expect(resumed).toMatchObject({
      kind: "already",
      title: "Already resumed",
      description: "It goes Tue 10 Nov, 09:14.",
    });
  });

  const answer = (kind: SalesHoldOutcome["kind"]): SalesHoldOutcome => ({
    kind,
    tone: "success",
    title: "",
    description: "",
    needsPress: false,
  });

  it("pauses each send in turn, says how far it got, and sums up truthfully", async () => {
    const answers = { a: "done", b: "going", c: "failed", d: "already" } as const;
    const seen: SalesBatchState[] = [];
    const finished = await runBatch(
      "Paused",
      ["a", "b", "c", "d"],
      async (id) => answer(answers[id as keyof typeof answers]),
      (state) => seen.push(state),
    );
    expect(seen.map((state) => state.text)).toEqual([
      "Pausing 1 of 4…",
      "Pausing 2 of 4…",
      "Pausing 3 of 4…",
      "Pausing 4 of 4…",
      "Paused 2 of 4. 1 was already going and could not be stopped. 1 was not paused.",
    ]);
    expect(seen.map((state) => state.running)).toEqual([true, true, true, true, false]);
    expect(finished).toEqual(seen.at(-1));
  });

  it("never counts a withdrawn approval as paused", async () => {
    const finished = await runBatch(
      "Paused",
      ["a", "b", "c"],
      async (id) => answer(id === "a" ? "done" : "withdrawn"),
      () => {},
    );
    expect(finished.text).toBe(
      "Paused 1 of 3. 2 were approved by a person: their approvals were withdrawn instead.",
    );
  });

  it("keeps on the row only what the batch summary can't settle", () => {
    expect(
      (["done", "already", "withdrawn", "going", "failed"] as const).filter((kind) =>
        showsOnRowAfterBatch(answer(kind)),
      ),
    ).toEqual(["withdrawn", "going", "failed"]);
  });

  it("asks before a batch, with how many it touches", () => {
    expect(batchConfirmText("Paused", 8)).toMatch(/^Pause 8 of today's automated sends\?\n/);
    expect(batchConfirmText("Resumed", 2)).toMatch(/^Resume 2 paused sends\?\n/);
  });
});
