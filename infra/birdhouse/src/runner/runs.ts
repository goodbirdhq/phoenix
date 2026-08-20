import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { OPEN_RUN_STATUSES, workflow, workflowRun } from "../db/schema.ts";
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

    // Computed from creation time so `sweepExpiredRuns` has a deadline to
    // enforce even if `workflow.launch` never runs at all. The launch
    // handler overwrites it with a fresh `now + timeout` at the moment the
    // Phoenix turn actually starts — queue backlog between "pending" and
    // "running" would otherwise silently eat into the run's budget.
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

export type ExpiredRunSweepSummary = Readonly<{ timedOut: number }>;

/**
 * Terminally fails every still-open run whose deadline has passed.
 *
 * The watch job enforces a run's timeout while its chain is alive, but that
 * chain is not guaranteed: a `workflow.launch` or `workflow.watch` job can
 * dead-letter (an expired Phoenix token, a deleted thread, a dispatch that
 * keeps 500ing), and nothing re-creates it. Without a sweep, a run whose
 * chain broke sits `pending`/`running` forever — no timeout, no failure, no
 * signal. This is the backstop that makes `timeout_at` mean something on
 * every path, so it runs on the scheduler's cadence rather than inside the
 * job chain it exists to cover for.
 *
 * The comparison runs in SQL against `now()`, and the status guard makes the
 * update idempotent against a watch job or callback completing the same run
 * concurrently — exactly one writer wins.
 */
export async function sweepExpiredRuns(db: Db): Promise<ExpiredRunSweepSummary> {
  const expired = await db
    .update(workflowRun)
    .set({
      status: "timed_out",
      completedAt: sql`now()`,
      error: "Run exceeded its timeout before reporting a result",
    })
    .where(
      and(
        inArray(workflowRun.status, [...OPEN_RUN_STATUSES]),
        sql`${workflowRun.timeoutAt} is not null and now() > ${workflowRun.timeoutAt}`,
      ),
    )
    .returning({ id: workflowRun.id, phoenixThreadId: workflowRun.phoenixThreadId });

  for (const run of expired) {
    await writeAuditEvent(db, {
      actor: "system",
      action: "run.completed",
      targetType: "workflow_run",
      targetId: run.id,
      outcome: "failed",
      reason: "timed_out",
      metadata: { completedVia: "sweep" },
    });
    // A run we timed out from outside its watch chain still has a live agent
    // session on the Phoenix side; stopping it is durable work, not
    // best-effort, so it goes through the queue.
    if (run.phoenixThreadId) {
      await enqueueStopSession(db, run.id, run.phoenixThreadId);
    }
  }

  if (expired.length > 0) {
    console.log(JSON.stringify({ event: "runs.swept_timed_out", count: expired.length }));
  }
  return { timedOut: expired.length };
}

/** Queues the Phoenix session stop for a run that has already gone terminal. */
export async function enqueueStopSession(db: Db, runId: string, threadId: string): Promise<void> {
  await enqueueJob({
    db,
    type: "workflow.stop",
    payload: { runId, threadId },
    idempotencyKey: `stop:${runId}`,
  });
}
