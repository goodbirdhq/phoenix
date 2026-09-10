import { describe, expect, it } from "vite-plus/test";
import {
  sortThreadsByAttention,
  hasUnreadThreadCompletion,
  type ThreadAttentionInput,
} from "./threadAttention.ts";

const NOW = "2026-09-10T12:00:00.000Z";
const BEFORE = "2026-09-10T11:00:00.000Z";
const EARLIER = "2026-09-10T10:00:00.000Z";
function thread(id: string, patch: Partial<ThreadAttentionInput> = {}): ThreadAttentionInput {
  return {
    id,
    environmentId: "local",
    session: { status: "ready" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    ...patch,
  };
}
function completed(id: string, at = BEFORE, patch: Partial<ThreadAttentionInput> = {}) {
  return thread(id, {
    latestTurn: { state: "completed", completedAt: at, requestedAt: EARLIER },
    ...patch,
  });
}
function order(
  threads: ThreadAttentionInput[],
  context: Partial<Parameters<typeof sortThreadsByAttention>[1]> = {},
) {
  return sortThreadsByAttention(threads, { threads, now: NOW, ...context }).map((t) => t.id);
}

describe("attention ordering", () => {
  it("puts human decisions before failures, unread results, working and quiet threads", () => {
    expect(
      order([
        thread("quiet"),
        thread("working", { session: { status: "running" } }),
        completed("result"),
        thread("failed", { session: { status: "error" } }),
        thread("input", { hasPendingUserInput: true }),
        thread("approval", { hasPendingApprovals: true }),
      ]),
    ).toEqual(["input", "approval", "failed", "result", "working", "quiet"]);
  });

  it("keeps viewed completions above running work and preserves order within each group", () => {
    expect(
      order(
        [
          thread("quiet"),
          thread("working", { session: { status: "running" } }),
          completed("read"),
          completed("read-2"),
          completed("unread"),
        ],
        {
          lastVisitedAtByKey: { "local:read": BEFORE, "local:read-2": BEFORE },
        },
      ),
    ).toEqual(["unread", "read", "read-2", "working", "quiet"]);
  });

  it("does not promote stopped, interrupted or missing sessions as completed work", () => {
    expect(
      order([
        thread("stopped", { session: { status: "stopped" } }),
        thread("interrupted", { session: { status: "interrupted" } }),
        thread("empty", { session: null }),
        completed("result"),
      ]),
    ).toEqual(["result", "stopped", "interrupted", "empty"]);
  });

  it("keeps a quiet parent below a result while children work, including hidden children", () => {
    const parent = completed("parent");
    const child = thread("child", { spawnedByThreadId: "parent", session: { status: "running" } });
    const result = completed("result");
    expect(order([parent, result], { threads: [parent, child, result] })).toEqual([
      "result",
      "parent",
    ]);
  });

  it("surfaces a descendant approval even while its parent is working", () => {
    const parent = thread("parent", { session: { status: "running" } });
    const child = thread("child", { spawnedByThreadId: "parent", hasPendingApprovals: true });
    const result = completed("result");
    expect(order([result, parent], { threads: [result, parent, child] })).toEqual([
      "parent",
      "result",
    ]);
  });

  it("keeps a child waiting on its parent out of the human-decision group", () => {
    const parent = completed("parent");
    const child = thread("child", {
      spawnedByThreadId: "parent",
      awaitingParentReplySince: BEFORE,
    });
    expect(order([parent, child, completed("result")])).toEqual(["result", "parent", "child"]);
  });

  it("waits for parent synthesis after a child finishes, then surfaces the parent's new result", () => {
    const parent = completed("parent", EARLIER);
    const child = completed("child", BEFORE, { spawnedByThreadId: "parent" });
    const result = completed("result");
    expect(order([parent, child, result])).toEqual(["result", "parent", "child"]);
    expect(order([completed("parent", NOW), child, result])).toEqual(["parent", "result", "child"]);
  });

  it("does not leave a reviewed parent classified as working just because completed children remain", () => {
    const parent = completed("parent", NOW);
    const child = completed("child", BEFORE, { spawnedByThreadId: "parent" });
    expect(
      order([parent, thread("working", { backgroundLiveness: "monitoring" }), child], {
        lastVisitedAtByKey: { "local:parent": NOW },
      }),
    ).toEqual(["parent", "working", "child"]);
  });

  it("recognizes actionable plans above background work", () => {
    expect(
      order([
        completed("result"),
        completed("plan", BEFORE, {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          backgroundLiveness: "monitoring",
        }),
      ]),
    ).toEqual(["plan", "result"]);
  });

  it("does not surface a stale plan after failure or while a follow-up is being adopted", () => {
    const plan = { interactionMode: "plan" as const, hasActionableProposedPlan: true };
    expect(
      order([
        completed("queued-plan", BEFORE, { ...plan, latestUserMessageAt: NOW }),
        completed("failed-plan", BEFORE, { ...plan, session: { status: "error" } }),
        completed("result"),
      ]),
    ).toEqual(["failed-plan", "result", "queued-plan"]);
  });

  it("does not treat background agents, monitors or a queued follow-up as finished", () => {
    expect(
      order([
        completed("agents", BEFORE, { backgroundLiveness: "working" }),
        completed("monitor", BEFORE, { backgroundLiveness: "monitoring" }),
        completed("queued", BEFORE, { latestUserMessageAt: NOW }),
        completed("result"),
      ]),
    ).toEqual(["result", "agents", "monitor", "queued"]);
  });

  it("expires a queued-start inference so an unaccepted message cannot hide a result forever", () => {
    expect(
      order([thread("quiet"), completed("old-queue", EARLIER, { latestUserMessageAt: BEFORE })]),
    ).toEqual(["old-queue", "quiet"]);
  });

  it("keeps parent identity environment-local and promotes orphaned child results", () => {
    expect(
      order([
        thread("parent", { environmentId: "remote" }),
        completed("child", BEFORE, { spawnedByThreadId: "parent" }),
      ]),
    ).toEqual(["child", "parent"]);
  });

  it("handles cyclic ancestry and invalid completion dates without dropping rows", () => {
    expect(
      order([
        thread("a", { spawnedByThreadId: "b" }),
        thread("b", { spawnedByThreadId: "a" }),
        completed("bad-date", "invalid"),
        completed("result"),
      ]),
    ).toEqual(["result", "a", "b", "bad-date"]);
  });
});

describe("attention review regressions", () => {
  it("keeps a processed parent result above autonomous work when the child finishes after its report", () => {
    const parent = completed("parent", "2026-09-10T11:00:10Z");
    const child = completed("child", "2026-09-10T11:00:15Z", {
      spawnedByThreadId: "parent",
      latestReportAt: "2026-09-10T11:00:00Z",
    });
    const working = thread("working", { session: { status: "running" } });
    expect(order([working, parent], { threads: [working, parent, child] })).toEqual([
      "parent",
      "working",
    ]);
  });

  it("does not borrow descendant decisions in a flat list", () => {
    const parent = thread("parent");
    const child = thread("child", { spawnedByThreadId: "parent", hasPendingApprovals: true });
    const failed = thread("failed", { session: { status: "error" } });
    expect(order([parent, child, failed], { propagateDescendantRank: false })).toEqual([
      "child",
      "failed",
      "parent",
    ]);
  });

  it("does not borrow decisions from descendants excluded by filters", () => {
    const parent = thread("parent");
    const child = thread("child", { spawnedByThreadId: "parent", hasPendingApprovals: true });
    const failed = thread("failed", { session: { status: "error" } });
    expect(
      order([parent, failed], {
        threads: [parent, child, failed],
        visibleThreadKeys: new Set(["local:parent", "local:failed"]),
      }),
    ).toEqual(["failed", "parent"]);
  });
});

it("does not label interrupted turns as unread results or healthy sessions as failed", () => {
  const interrupted = completed("interrupted");
  expect(
    hasUnreadThreadCompletion(
      { ...interrupted, latestTurn: { ...interrupted.latestTurn!, state: "interrupted" } },
      undefined,
    ),
  ).toBe(false);
  const checkpointFailure = thread("checkpoint-error", {
    latestTurn: { state: "error", completedAt: BEFORE, requestedAt: EARLIER },
  });
  expect(order([checkpointFailure, completed("result")])).toEqual(["result", "checkpoint-error"]);
});

it("keeps a parent autonomous until its queued report has been processed", () => {
  const parent = {
    ...completed("parent", "2026-09-10T11:00:10Z", {
      latestUserMessageAt: "2026-09-10T11:00:00Z",
    }),
    hasPendingTurnStart: true,
  };
  const child = completed("child", "2026-09-10T11:00:15Z", {
    spawnedByThreadId: "parent",
    latestReportAt: "2026-09-10T11:00:00Z",
  });
  const working = thread("working", { session: { status: "running" } });
  expect(order([working, parent], { threads: [working, parent, child] })).toEqual([
    "working",
    "parent",
  ]);
  const processing = {
    ...parent,
    hasPendingTurnStart: false,
    session: { status: "running" as const },
  };
  expect(order([working, processing], { threads: [working, processing, child] })).toEqual([
    "working",
    "parent",
  ]);
  const processed = {
    ...completed("parent", "2026-09-10T11:01:00Z"),
    hasPendingTurnStart: false,
  };
  expect(order([working, processed], { threads: [working, processed, child] })).toEqual([
    "parent",
    "working",
  ]);
});

it("trusts an empty pending-start signal over the legacy message-time guess", () => {
  const result = {
    ...completed("result", BEFORE, { latestUserMessageAt: NOW }),
    hasPendingTurnStart: false,
  };
  const working = thread("working", { session: { status: "running" } });
  expect(order([working, result])).toEqual(["result", "working"]);
});

it("retains human decision priority while a turn start is pending", () => {
  const decision = {
    ...thread("decision", { hasPendingApprovals: true }),
    hasPendingTurnStart: true,
  };
  expect(order([completed("result"), decision])).toEqual(["decision", "result"]);
});

it("does not promote viewed parent completions while children or queued deliveries are pending", () => {
  const parent = completed("parent");
  const child = thread("child", { spawnedByThreadId: "parent", session: { status: "running" } });
  const finished = completed("finished");
  const pending = { ...completed("pending"), hasPendingTurnStart: true };
  expect(
    order([parent, pending, finished], {
      threads: [parent, child, pending, finished],
      lastVisitedAtByKey: {
        "local:parent": BEFORE,
        "local:pending": BEFORE,
        "local:finished": BEFORE,
      },
    }),
  ).toEqual(["finished", "parent", "pending"]);
});
