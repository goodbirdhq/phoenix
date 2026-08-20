import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { workflow, workflowRun } from "../db/schema.ts";
import { enqueueJob } from "../jobs/queue.ts";
import { writeAuditEvent } from "./audit.ts";
import { mintCallbackToken } from "./callbackToken.ts";

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

/** `manifest.timeout_ms` if present and numeric, else the process default. */
export function resolveWorkflowTimeoutMs(manifest: unknown): number {
  const timeoutMs =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>).timeout_ms
      : undefined;
  return typeof timeoutMs === "number" && timeoutMs > 0
    ? timeoutMs
    : config.BIRDHOUSE_RUN_TIMEOUT_MS;
}

function auditActorFor(trigger: WorkflowRunTrigger): string {
  // The scheduler and the HTTP API are their own actors; a manual run is
  // always operator-initiated through the CLI today, so it's attributed to
  // "cli" rather than the generic "manual" trigger label.
  return trigger === "manual" ? "cli" : trigger;
}

/**
 * Insert a workflow_run row and enqueue the ops_job that launches it.
 *
 * Runs the insert/enqueue/link sequence in one transaction: `enqueueJob`'s
 * idempotency dedupe means a caller can race another enqueue of the same
 * logical run (e.g. a redelivered API call), and losing that race must leave
 * neither an orphaned run row nor a run pointing at the wrong job.
 */
export async function createWorkflowRun(
  input: CreateWorkflowRunInput,
): Promise<CreateWorkflowRunResult> {
  const { trigger, workflowKey, dedupeKey } = input;
  const actor = auditActorFor(trigger);

  return input.db.transaction(async (tx) => {
    const [workflowRow] = await tx
      .select()
      .from(workflow)
      .where(eq(workflow.key, workflowKey))
      .limit(1);
    if (!workflowRow) {
      throw new Error(`createWorkflowRun: unknown workflow "${workflowKey}"`);
    }
    if (!workflowRow.enabled) {
      throw new Error(`createWorkflowRun: workflow "${workflowKey}" is disabled`);
    }

    const runId = randomUUID();
    const { token: callbackToken, hash: callbackTokenHash } = mintCallbackToken();
    const timeoutMs = resolveWorkflowTimeoutMs(workflowRow.manifest);
    const now = new Date();

    // This timeoutAt is a placeholder computed from creation time, good
    // enough to serve as a safety bound if `workflow.launch` never runs. The
    // launch handler overwrites it with a fresh `now + timeout` computed at
    // the moment the Phoenix turn actually starts — queue backlog between
    // "pending" and "running" would otherwise silently eat into the run's
    // timeout budget.
    const [insertedRun] = await tx
      .insert(workflowRun)
      .values({
        id: runId,
        workflowKey,
        trigger,
        status: "pending",
        input: (input.input ?? null) as Record<string, unknown> | null,
        mode: workflowRow.mode,
        callbackTokenHash,
        timeoutAt: new Date(now.getTime() + timeoutMs),
      })
      .returning();
    if (!insertedRun) {
      throw new Error(`createWorkflowRun: failed to insert run for workflow "${workflowKey}"`);
    }

    const idempotencyKey = dedupeKey ?? `run:${runId}`;
    const job = await enqueueJob({
      db: tx,
      type: "workflow.launch",
      payload: { runId, callbackToken },
      idempotencyKey,
      priority: 100,
    });

    const jobPayloadRunId = (job.payload as { runId?: unknown }).runId;
    if (typeof jobPayloadRunId !== "string") {
      throw new Error(
        `createWorkflowRun: workflow.launch job ${job.id} has no string payload.runId`,
      );
    }

    if (jobPayloadRunId !== runId) {
      // Lost the idempotency race: dedupeKey matched a job enqueued by an
      // earlier call. That call's run row is the real one; ours is an
      // orphan the moment the job insert didn't happen for it.
      await tx.delete(workflowRun).where(eq(workflowRun.id, runId));
      await writeAuditEvent(tx, {
        actor,
        action: "run.created",
        targetType: "workflow_run",
        targetId: jobPayloadRunId,
        outcome: "attempted",
        reason: "deduped",
        metadata: { workflowKey, idempotencyKey },
      });
      return { runId: jobPayloadRunId, created: false };
    }

    await tx.update(workflowRun).set({ jobId: job.id }).where(eq(workflowRun.id, runId));
    await writeAuditEvent(tx, {
      actor,
      action: "run.created",
      targetType: "workflow_run",
      targetId: runId,
      outcome: "succeeded",
      metadata: { workflowKey, trigger, jobId: job.id },
    });

    return { runId, created: true };
  });
}
