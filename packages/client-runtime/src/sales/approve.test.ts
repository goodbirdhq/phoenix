import {
  SalesActionError,
  type SalesApproveResult,
  type SalesSignedApproval,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import type { VerifiedVersion } from "./approval.ts";
import { approveVersions, reviewTickedDraft } from "./approve.ts";
import { ENGINE_HASH, detail } from "./fixtures/queueItemDetail.ts";

// Only the verify functions make these; the tests here start after verification.
const verified = (activityId: string) =>
  ({ activityId, contentHash: `${activityId}-hash` }) as VerifiedVersion;

const sign = async (version: VerifiedVersion): Promise<SalesSignedApproval> => ({
  activityId: version.activityId,
  contentHash: version.contentHash,
  deviceId: "laptop-3f2a",
  signedAt: "2026-11-10T09:14:03.120Z",
  signature: "sig",
});

const card = (activityId: string, goes: string | null = null) => ({
  activityId,
  contentHash: `${activityId}-hash`,
  state: "approved",
  approved: true,
  approvedBy: "laptop-3f2a",
  sendAt: null,
  goes,
  refusal: null,
  note: null,
});

const approvesAll = async (
  items: ReadonlyArray<SalesSignedApproval>,
): Promise<AtomCommandResult<SalesApproveResult, unknown>> =>
  AsyncResult.success({
    results: items.map((item) => ({ ok: true, already: false, card: card(item.activityId) })),
  });

const refusedWith =
  (origin: SalesActionError["origin"], reason: SalesActionError["reason"]) =>
  async (): Promise<AtomCommandResult<SalesApproveResult, unknown>> =>
    AsyncResult.failure(
      Cause.fail(
        new SalesActionError({
          origin,
          reason,
          message: "The engine refused the token.",
          currentHash: null,
          state: null,
        }),
      ),
    );

describe("approveVersions", () => {
  it("sends batches of the engine's limit and reports every draft in order", async () => {
    const batches: number[] = [];
    const versions = Array.from({ length: 30 }, (_, index) => verified(`act-${index}`));
    const outcomes = await approveVersions({
      versions,
      approve: (items) => {
        batches.push(items.length);
        return approvesAll(items);
      },
      refresh: async () => {},
      blockedReason: () => null,
      sign,
    });
    expect(batches).toEqual([25, 5]);
    expect(outcomes.map((outcome) => outcome.activityId)).toEqual(
      versions.map((version) => version.activityId),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it("checks the device guard again before each batch and signs nothing it refuses", async () => {
    const signed: string[] = [];
    let checks = 0;
    const outcomes = await approveVersions({
      versions: Array.from({ length: 26 }, (_, index) => verified(`act-${index}`)),
      approve: approvesAll,
      refresh: async () => {},
      // The client gained a local backend with an engine between the two batches.
      blockedReason: () => (checks++ === 0 ? null : "Approve from another computer."),
      sign: (version) => {
        signed.push(version.activityId);
        return sign(version);
      },
    });
    expect(signed).toHaveLength(25);
    expect(outcomes.at(-1)).toEqual({
      activityId: "act-25",
      ok: false,
      text: "Approve from another computer.",
      stale: false,
      unknown: false,
    });
  });

  it("calls a request that may have landed unknown and reads the queue again", async () => {
    let refreshes = 0;
    const outcomes = await approveVersions({
      versions: [verified("act-1"), verified("act-2")],
      approve: refusedWith("transport", "unreachable"),
      refresh: async () => {
        refreshes += 1;
      },
      blockedReason: () => null,
      sign,
    });
    expect(outcomes.map((outcome) => outcome.unknown)).toEqual([true, true]);
    expect(refreshes).toBe(1);
  });

  it("says nothing was approved when the engine refused the request", async () => {
    let refreshes = 0;
    const [outcome] = await approveVersions({
      versions: [verified("act-1")],
      approve: refusedWith("engine", "unauthorised"),
      refresh: async () => {
        refreshes += 1;
      },
      blockedReason: () => null,
      sign,
    });
    expect(outcome).toMatchObject({ ok: false, unknown: false, stale: false });
    expect(refreshes).toBe(0);
  });

  it("tells each item's answer apart: approved, already approved, and moved on", async () => {
    const outcomes = await approveVersions({
      versions: [verified("act-1"), verified("act-2"), verified("act-3")],
      approve: async () =>
        AsyncResult.success({
          results: [
            { ok: true, already: false, card: card("act-1", "Tue 09:10") },
            { ok: true, already: true, card: card("act-2") },
            {
              ok: false,
              activityId: "act-3",
              reason: "stale_hash",
              message: "Moved on.",
              currentHash: "new-hash",
            },
          ],
        }),
      refresh: async () => {},
      blockedReason: () => null,
      sign,
    });
    expect(outcomes.map(({ text, stale }) => ({ text, stale }))).toEqual([
      { text: "Approved. Goes Tue 09:10.", stale: false },
      { text: "Already approved.", stale: false },
      {
        text: "It changed since you read it. Read the new version and approve again.",
        stale: true,
      },
    ]);
  });
});

describe("reviewTickedDraft", () => {
  it("is ready to sign only the version the person ticked, as the review step shows it", async () => {
    const reviewed = await reviewTickedDraft(
      async () => AsyncResult.success(detail()),
      ENGINE_HASH,
    );
    expect(reviewed).toMatchObject({
      status: "ready",
      version: { activityId: "act-1", contentHash: ENGINE_HASH },
    });
  });

  it("refuses a draft that moved on after the tick", async () => {
    const reviewed = await reviewTickedDraft(
      async () => AsyncResult.success(detail()),
      "0".repeat(64),
    );
    expect(reviewed).toEqual({
      status: "refused",
      text: "It changed after you ticked it. Open it and read the new version.",
    });
  });
});
