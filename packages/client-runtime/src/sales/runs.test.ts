import {
  type OrchestrationLatestTurn,
  type OrchestrationSessionStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { salesRunSettled, salesRunStatus } from "./runs.ts";

type Shell = NonNullable<Parameters<typeof salesRunStatus>[0]>;

const AT = "2026-11-10T09:00:00.000Z";

const shell = (
  session: OrchestrationSessionStatus | null,
  turn: OrchestrationLatestTurn["state"] | null,
  patch: Partial<Shell> = {},
): Shell => ({
  session:
    session === null
      ? null
      : {
          threadId: ThreadId.make("sales:card:act-1:t1"),
          status: session,
          providerName: "codex",
          runtimeMode: "auto",
          activeTurnId: null,
          lastError: null,
          episodeStartedAt: null,
          queuedDeliveryMessageId: null,
          updatedAt: AT,
        },
  latestTurn:
    turn === null
      ? null
      : {
          turnId: TurnId.make("turn-1"),
          state: turn,
          requestedAt: AT,
          startedAt: AT,
          completedAt: turn === "running" ? null : AT,
          assistantMessageId: null,
        },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...patch,
});

describe("salesRunStatus", () => {
  it("reads a run from its session and latest turn", () => {
    expect(salesRunStatus(null)).toBe("starting");
    expect(salesRunStatus(shell("starting", null))).toBe("starting");
    expect(salesRunStatus(shell("running", "running"))).toBe("running");
    expect(salesRunStatus(shell("ready", "completed"))).toBe("finished");
    expect(salesRunStatus(shell("error", "error"))).toBe("failed");
    expect(salesRunStatus(shell("error", null))).toBe("failed");
    expect(salesRunStatus(shell("ready", "interrupted"))).toBe("stopped");
  });

  it("puts a question to the person ahead of everything else", () => {
    expect(salesRunStatus(shell("running", "running", { hasPendingUserInput: true }))).toBe(
      "waiting",
    );
    expect(salesRunStatus(shell("running", "running", { hasPendingApprovals: true }))).toBe(
      "waiting",
    );
  });

  it("puts a failed session ahead of background work still reported live", () => {
    expect(salesRunStatus(shell("error", "error", { backgroundLiveness: "working" }))).toBe(
      "failed",
    );
  });

  it("reads a session at rest with no turn as stopped, not starting", () => {
    expect(salesRunStatus(shell("stopped", null))).toBe("stopped");
    expect(salesRunStatus(shell(null, null))).toBe("starting");
  });

  it("keeps a settled turn running while background work or a queued turn goes on", () => {
    expect(salesRunStatus(shell("ready", "completed", { backgroundLiveness: "working" }))).toBe(
      "running",
    );
    expect(salesRunStatus(shell("ready", "completed", { hasPendingTurnStart: true }))).toBe(
      "starting",
    );
  });
});

describe("salesRunSettled", () => {
  it("fires once, when an active run comes to rest", () => {
    expect(salesRunSettled("running", "finished")).toBe(true);
    expect(salesRunSettled("waiting", "failed")).toBe(true);
    expect(salesRunSettled("finished", "finished")).toBe(false);
    expect(salesRunSettled("running", "waiting")).toBe(false);
  });

  it("ignores a run first seen at rest", () => {
    expect(salesRunSettled(undefined, "finished")).toBe(false);
  });
});
