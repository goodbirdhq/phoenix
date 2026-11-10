import {
  ProjectId,
  SalesActionError,
  type SalesActionFailureReason,
  type SalesQueueItemDetail,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import type { VerifiedVersion } from "./approval.ts";
import type { ApproveOutcome } from "./approve.ts";
import type { SalesDeviceKey } from "./devices.ts";
import { createDraftCard, type DraftCardCommands, type DraftCardDevice } from "./draftCard.ts";
import { ENGINE_HASH, detail, hashInput } from "./fixtures/queueItemDetail.ts";

// Approval never reads the private key here: signing is `approveVersions`' job.
const key = {
  engine: "https://engine.example.com",
  deviceId: "laptop-3f2a",
  fingerprint: "3f2a".repeat(16),
} as SalesDeviceKey;
const activeDevice: DraftCardDevice = { key, state: "active", blocked: null };

const refused = <A>(
  reason: SalesActionFailureReason,
  state: string | null = null,
): AtomCommandResult<A, unknown> =>
  AsyncResult.failure(
    Cause.fail(
      new SalesActionError({
        origin: "engine",
        reason,
        message: "Refused.",
        currentHash: null,
        state,
      }),
    ),
  );

/** A card over a fake engine that serves `served` and records what was asked of it. */
function setup(options: {
  readonly served?: SalesQueueItemDetail;
  readonly approved?: ApproveOutcome;
  readonly commands?: Partial<DraftCardCommands>;
}) {
  let served = options.served ?? detail();
  const calls = { reads: 0, signed: [] as VerifiedVersion[], discarded: [] as string[] };
  const commands: DraftCardCommands = {
    getQueueItem: async () => {
      calls.reads += 1;
      return AsyncResult.success(served);
    },
    edit: async () => refused("stale_hash"),
    discard: async (expectedHash) => {
      calls.discarded.push(expectedHash);
      return refused("not_open");
    },
    unapprove: async () => refused("not_approved"),
    dispatch: async () => refused("dispatch-failed"),
    approveVersions: async (_key, versions) => {
      calls.signed.push(...versions);
      return versions.map(
        (version) =>
          options.approved ?? {
            activityId: version.activityId,
            ok: true,
            text: "Approved.",
            stale: false,
            unknown: false,
          },
      );
    },
    confirm: () => Promise.resolve(true),
    onChanged: () => {},
    onAnswerDiscarded: () => {},
    ...options.commands,
  };
  const card = createDraftCard(commands, served.contentHash);
  return {
    card,
    calls,
    serve: (next: SalesQueueItemDetail) => {
      served = next;
    },
  };
}

describe("draft card approval", () => {
  it("signs exactly the version it hashed from the text it shows", async () => {
    const { card, calls } = setup({});
    await card.load();
    await card.approve(activeDevice);
    expect(calls.signed).toEqual([{ activityId: "act-1", contentHash: ENGINE_HASH }]);
    expect(card.getState().notice).toMatchObject({ tone: "success", title: "Approved" });
  });

  it("refuses to sign text that is not the version the engine reports, and reads it again", async () => {
    const { card, calls } = setup({
      served: detail({ hashInput: { ...hashInput, body: "Wire the money." } }),
    });
    await card.load();
    await card.approve(activeDevice);
    expect(calls.signed).toEqual([]);
    expect(calls.reads).toBe(2);
    expect(card.getState().notice).toMatchObject({
      tone: "error",
      title: "Phoenix will not sign this",
    });
  });

  it("signs nothing while an edit is unsaved, or on a device that cannot sign", async () => {
    const { card, calls } = setup({});
    await card.load();
    card.editBody("Hey Ana, rewritten.");
    await card.approve(activeDevice);
    expect(card.getState().notice?.title).toBe("Save or cancel your edit before approving.");

    card.cancelEdit();
    await card.approve({ ...activeDevice, blocked: "Approve from another computer." });
    expect(card.getState().notice?.title).toBe("This client cannot approve");
    await card.approve({ ...activeDevice, state: "pending" });
    expect(card.getState().notice?.title).toBe("This device cannot approve");
    expect(calls.signed).toEqual([]);
  });

  it("shows a version that moved on as not approved, read again, never signed twice", async () => {
    const { card, calls } = setup({
      approved: {
        activityId: "act-1",
        ok: false,
        text: "It changed since you read it.",
        stale: true,
        unknown: false,
      },
    });
    await card.load();
    await card.approve(activeDevice);
    expect(card.getState().notice).toMatchObject({ tone: "warning", title: "Not approved" });
    expect(calls.signed).toHaveLength(1);
    expect(calls.reads).toBe(2);
  });
});

describe("draft card edits", () => {
  it("keeps the person's text when the engine refuses an edit because the card moved on", async () => {
    const { card } = setup({});
    await card.load();
    card.editBody("My careful rewrite.");
    await card.save();
    const state = card.getState();
    expect(state.lostText).toBe("My careful rewrite.");
    // Read again, so the edit is gone from the field and the engine's version shows.
    expect(state.bodyDraft).toBeNull();
    expect(state.notice).toMatchObject({ tone: "error", title: "This draft changed" });
  });

  it("sends a subject only for a new thread whose subject was edited", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const { card } = setup({
      served: detail({ threaded: false }),
      commands: {
        edit: async (input) => {
          sent.push({ ...input });
          return refused("empty_body");
        },
      },
    });
    await card.load();
    card.editBody("Body only.");
    await card.save();
    card.editSubject("A new subject");
    await card.save();
    expect(sent.map((input) => "subject" in input)).toEqual([false, true]);
  });

  it("reads a card the list says moved on, unless the person is mid-edit", async () => {
    const { card, calls } = setup({});
    await card.load();
    card.editBody("Half written.");
    card.setListedHash("f".repeat(64));
    expect(calls.reads).toBe(1);
    expect(card.getState().notice?.title).toBe("This draft changed in the engine");

    // Cancelling the edit shows the engine's newer version.
    card.cancelEdit();
    await Promise.resolve();
    expect(calls.reads).toBe(2);
  });
});

describe("draft card actions", () => {
  it("discards nothing when it cannot ask the person to confirm", async () => {
    const { card, calls } = setup({ commands: { confirm: () => undefined } });
    await card.load();
    await card.discard("Discard this draft");
    expect(calls.discarded).toEqual([]);
    expect(card.getState().notice?.title).toBe("Could not ask to confirm");
  });

  it("discards the version shown once the person confirms", async () => {
    const { card, calls } = setup({});
    await card.load();
    await card.discard("Discard this draft");
    expect(calls.discarded).toEqual([ENGINE_HASH]);
  });

  it("tells the page when a reply redraft discarded the answer but did not start", async () => {
    const discarded: string[] = [];
    const { card } = setup({
      commands: {
        dispatch: async () => refused("dispatch-failed", "discarded"),
        onAnswerDiscarded: (message) => discarded.push(message),
      },
    });
    await card.load();
    card.toggleRedraft();
    card.setRedraftNote("Shorter, and mention Tuesday.");
    await card.startRedraft();
    expect(discarded).toEqual(["Refused."]);
  });

  it("links the thread a dispatch started and closes the redraft form", async () => {
    const thread = {
      target: "act-1",
      action: "redraft" as const,
      skill: "chase-drafting",
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Redraft Ana",
      startedAt: "2026-11-10T09:00:00.000Z",
    };
    const { card } = setup({
      commands: { dispatch: async () => AsyncResult.success(thread) },
    });
    await card.load();
    card.toggleRedraft();
    card.setRedraftNote("Shorter.");
    await card.startRedraft();
    expect(card.getState().redraftNote).toBeNull();
    expect(card.getState().notice).toMatchObject({ title: "Run started", thread });
  });
});
