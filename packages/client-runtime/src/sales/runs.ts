import type { OrchestrationThreadShell } from "@t3tools/contracts";

/** Where a run dispatched from Sales stands, read from its thread shell. */
export type SalesRunStatus = "starting" | "running" | "waiting" | "failed" | "stopped" | "finished";

export const SALES_RUN_STATUS_LABELS: Record<SalesRunStatus, string> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting for input",
  failed: "Failed",
  stopped: "Stopped",
  finished: "Finished",
};

type RunShell = Pick<
  OrchestrationThreadShell,
  | "session"
  | "latestTurn"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasPendingTurnStart"
  | "backgroundLiveness"
>;

/** A run's status. A thread not in the read model yet is starting. */
export function salesRunStatus(shell: RunShell | null): SalesRunStatus {
  if (shell === null) return "starting";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "waiting";
  const session = shell.session?.status ?? null;
  const turn = shell.latestTurn?.state ?? null;
  if (session === "running" || turn === "running" || shell.backgroundLiveness === "working") {
    return "running";
  }
  if (session === "starting" || shell.hasPendingTurnStart === true || turn === null) {
    return session === "error" ? "failed" : "starting";
  }
  if (session === "error" || turn === "error") return "failed";
  if (turn === "interrupted") return "stopped";
  return "finished";
}

const ACTIVE: ReadonlySet<SalesRunStatus> = new Set(["starting", "running", "waiting"]);

/**
 * Whether a run just came to rest, so the card or conversation it started from should be read
 * once more for what it wrote. A run first seen at rest says nothing new.
 */
export const salesRunSettled = (previous: SalesRunStatus | undefined, next: SalesRunStatus) =>
  previous !== undefined && ACTIVE.has(previous) && !ACTIVE.has(next);
