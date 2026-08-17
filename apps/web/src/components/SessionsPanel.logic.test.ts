import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { buildSessionPanelModel } from "./SessionsPanel.logic.ts";

function shell(overrides: Record<string, unknown> & { id: string }) {
  return {
    projectId: "project-1",
    title: "Child session",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    runtimeMode: "full-access",
    interactionMode: "agent",
    branch: "t3code/abc",
    worktreePath: "/tmp/worktree",
    spawnedByThreadId: "parent-1",
    latestTurn: null,
    createdAt: "2026-08-17T22:38:00.000Z",
    updatedAt: "2026-08-17T22:38:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

describe("buildSessionPanelModel", () => {
  it("splits children into active and settled history, newest first", () => {
    const model = buildSessionPanelModel([
      shell({ id: "a", createdAt: "2026-08-17T22:38:00.000Z" }),
      shell({
        id: "b",
        createdAt: "2026-08-17T22:39:00.000Z",
        settledAt: "2026-08-17T23:10:00.000Z",
      }),
      shell({ id: "c", createdAt: "2026-08-17T22:40:00.000Z" }),
    ]);

    expect(model.active.map((entry) => entry.threadId)).toEqual(["c", "a"]);
    expect(model.settled.map((entry) => entry.threadId)).toEqual(["b"]);
    expect(model.total).toBe(3);
    expect(model.activeCount).toBe(1 + 1);
    expect(model.settledCount).toBe(1);
  });

  it("keeps a settled child whose worktree was reclaimed in the history list", () => {
    const model = buildSessionPanelModel([
      shell({ id: "a", settledAt: "2026-08-17T23:10:00.000Z", worktreePath: null }),
    ]);

    expect(model.settled[0]).toMatchObject({ lifecycle: "settled", worktreePath: null });
    expect(model.activeCount).toBe(0);
  });

  it("reads a settled child whose process has not died yet as stopping, not working", () => {
    // settle_session can time out stopping the provider; the row must not
    // claim idle (a lie) nor working (it is already history).
    const model = buildSessionPanelModel([
      shell({
        id: "a",
        settledAt: "2026-08-17T23:10:00.000Z",
        session: { status: "running" } as never,
      }),
    ]);

    expect(model.settled[0]?.activity).toBe("stopping");
    expect(model.workingCount).toBe(0);
    expect(model.activeCount).toBe(0);
  });

  it("reads starting and running sessions as one steady working state", () => {
    const model = buildSessionPanelModel([
      shell({ id: "a", session: { status: "starting" } as never }),
      shell({ id: "b", session: { status: "running" } as never }),
    ]);

    expect(model.active.every((entry) => entry.activity === "working")).toBe(true);
    expect(model.workingCount).toBe(2);
  });

  it("lets a blocked child outrank a working one", () => {
    const model = buildSessionPanelModel([
      shell({ id: "a", hasPendingApprovals: true, session: { status: "running" } as never }),
      shell({ id: "b", hasPendingUserInput: true }),
    ]);

    expect(model.active.map((entry) => entry.activity)).toEqual(["needs-you", "needs-you"]);
    expect(model.needsAttentionCount).toBe(2);
    expect(model.workingCount).toBe(0);
  });

  it("ignores stale background liveness on a settled child", () => {
    const model = buildSessionPanelModel([
      shell({
        id: "a",
        settledAt: "2026-08-17T23:10:00.000Z",
        backgroundLiveness: "working",
        session: { status: "ready" } as never,
      }),
    ]);

    expect(model.settled[0]?.activity).toBe("idle");
    expect(model.workingCount).toBe(0);
  });

  it("surfaces monitoring background work distinctly from a turn", () => {
    const model = buildSessionPanelModel([
      shell({ id: "a", backgroundLiveness: "monitoring", session: { status: "ready" } as never }),
    ]);

    expect(model.active[0]?.activity).toBe("monitoring");
    expect(model.workingCount).toBe(1);
  });

  it("keeps a same-millisecond fan-out in a stable order", () => {
    const spawnedAt = "2026-08-17T22:38:00.000Z";
    const ids = ["c", "a", "b"].map((id) => shell({ id, createdAt: spawnedAt }));
    expect(buildSessionPanelModel(ids).active.map((entry) => entry.threadId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("takes last activity from the newest available signal", () => {
    const model = buildSessionPanelModel([
      shell({
        id: "a",
        updatedAt: "2026-08-17T22:38:00.000Z",
        session: { status: "ready", updatedAt: "2026-08-17T23:05:00.000Z" } as never,
      }),
    ]);

    expect(model.active[0]?.lastActivityAt).toBe("2026-08-17T23:05:00.000Z");
  });

  it("never lets a malformed timestamp win the last-activity race", () => {
    const model = buildSessionPanelModel([
      shell({
        id: "a",
        createdAt: "2026-08-17T22:38:00.000Z",
        updatedAt: "not-a-date",
        session: { status: "ready", updatedAt: "also-not-a-date" } as never,
      }),
    ]);

    expect(model.active[0]?.lastActivityAt).toBe("2026-08-17T22:38:00.000Z");
  });

  it("returns the shared empty model when nothing was spawned", () => {
    expect(buildSessionPanelModel([]).total).toBe(0);
  });
});
