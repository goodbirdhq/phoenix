import { describe, expect, it } from "vite-plus/test";

import { salesRunSettled, salesRunStatus } from "./runs.ts";

type Shell = NonNullable<Parameters<typeof salesRunStatus>[0]>;

const shell = (
  session: string | null,
  turn: string | null,
  patch: Partial<Record<keyof Shell, unknown>> = {},
): Shell =>
  ({
    session: session === null ? null : { status: session },
    latestTurn: turn === null ? null : { state: turn },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...patch,
  }) as Shell;

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
