import type { Db } from "../db/client.js";

export type WorkflowRunTrigger = "schedule" | "manual" | "api";

export interface CreateWorkflowRunInput {
  db: Db;
  workflowKey: string;
  trigger: WorkflowRunTrigger;
  input?: unknown;
  /**
   * Deduplication key for the backing job. Callers that can fire more than
   * once for the same logical occurrence (the scheduler, retried API calls)
   * must pass a stable key, e.g. `schedule:{scheduleId}:{occurrenceIso}`.
   */
  dedupeKey?: string;
}

export interface CreateWorkflowRunResult {
  runId: string;
  /** False when dedupeKey matched an existing job and no new run started. */
  created: boolean;
}

/**
 * Insert a workflow_run row and enqueue the ops_job that launches it.
 * Implemented by the runner module (wave 2); the signature is frozen so the
 * scheduler and CLI can build against it.
 */
export async function createWorkflowRun(
  _input: CreateWorkflowRunInput,
): Promise<CreateWorkflowRunResult> {
  throw new Error("createWorkflowRun is not implemented yet (runner wave)");
}
