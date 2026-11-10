import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { resolveThreadStatus } from "../state/threadAttention.ts";

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
  | "awaitingParentReplySince"
>;

/**
 * A run's status: the shared thread status (`resolveThreadStatus`), with a thread at rest read
 * by how its latest turn ended. A thread not in the read model yet is starting.
 */
export function salesRunStatus(shell: RunShell | null): SalesRunStatus {
  if (shell === null) return "starting";
  switch (resolveThreadStatus(shell)) {
    case "approval":
    case "input":
    case "awaiting-parent":
      return "waiting";
    case "working":
    case "monitoring":
      return shell.session?.status === "starting" ? "starting" : "running";
    case "failed":
      return "failed";
    case "ready":
      break;
  }
  if (shell.session === null || shell.hasPendingTurnStart === true) return "starting";
  switch (shell.latestTurn?.state) {
    case "completed":
      return "finished";
    case "error":
      return "failed";
    case "running":
      return "running";
    default:
      return "stopped";
  }
}

const ACTIVE: ReadonlySet<SalesRunStatus> = new Set(["starting", "running", "waiting"]);

/**
 * Whether a run just came to rest, so the card or conversation it started from should be read
 * once more for what it wrote. A run first seen at rest says nothing new.
 */
export const salesRunSettled = (previous: SalesRunStatus | undefined, next: SalesRunStatus) =>
  previous !== undefined && ACTIVE.has(previous) && !ACTIVE.has(next);
