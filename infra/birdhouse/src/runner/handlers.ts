import { and, eq, inArray, sql } from "drizzle-orm";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { isTerminalRunStatus, OPEN_RUN_STATUSES, workflow, workflowRun } from "../db/schema.ts";
import { TerminalJobError } from "../jobs/errors.ts";
import { enqueueJob } from "../jobs/queue.ts";
import type { ActiveJobLease, JobHandlerDefinition, OpsJobRow } from "../jobs/types.ts";
import { defineJobHandler } from "../jobs/types.ts";
import {
  PhoenixInvalidRequestError,
  type PhoenixClient,
  type PhoenixThreadDetail,
} from "../phoenix/client.ts";
import { loadSkillMarkdown } from "../workflows/skill.ts";
import { writeAuditEvent } from "./audit.ts";
import { deriveRunPhoenixIds } from "./ids.ts";
import { buildRunPrompt } from "./prompt.ts";
import { enqueueStopSession, resolveWorkflowTimeoutMs } from "./runs.ts";

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Per-workflow Phoenix overrides from `manifest.phoenix`, falling back to the
 * process defaults. The manifest schema has always accepted these; reading
 * them here is what makes them mean anything — a workflow declaring, say,
 * `runtime_mode: "approval-required"` because it touches real email must not
 * quietly launch under the global default.
 */
function resolvePhoenixLaunchSettings(manifest: unknown): {
  providerInstanceId: string;
  model: string;
  runtimeMode: typeof config.PHOENIX_RUNTIME_MODE;
} {
  const phoenix =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { phoenix?: Record<string, unknown> }).phoenix
      : undefined;
  const providerInstanceId = phoenix?.provider_instance_id;
  const model = phoenix?.model;
  const runtimeMode = phoenix?.runtime_mode;
  return {
    providerInstanceId:
      typeof providerInstanceId === "string" && providerInstanceId.length > 0
        ? providerInstanceId
        : config.PHOENIX_PROVIDER_INSTANCE_ID,
    model: typeof model === "string" && model.length > 0 ? model : config.PHOENIX_MODEL,
    runtimeMode: (typeof runtimeMode === "string" && runtimeMode.length > 0
      ? runtimeMode
      : config.PHOENIX_RUNTIME_MODE) as typeof config.PHOENIX_RUNTIME_MODE,
  };
}

/** Idempotent on `watch:{runId}:{attempt}`, so re-asserting an existing link is a no-op. */
async function enqueueWatch(db: Db, runId: string, attempt: number): Promise<void> {
  await enqueueJob({
    db,
    type: "workflow.watch",
    payload: { runId, attempt },
    idempotencyKey: `watch:${runId}:${attempt}`,
    runAfter: new Date(Date.now() + config.BIRDHOUSE_RUN_WATCH_INTERVAL_MS),
  });
}

async function loadRun(db: Db, runId: string) {
  const [run] = await db.select().from(workflowRun).where(eq(workflowRun.id, runId)).limit(1);
  return run;
}

async function loadWorkflow(db: Db, workflowKey: string) {
  const [row] = await db.select().from(workflow).where(eq(workflow.key, workflowKey)).limit(1);
  return row;
}

/** Guarded terminal failure: only ever moves a still-open run to 'failed'. */
async function failRunTerminally(db: Db, runId: string, error: string): Promise<void> {
  const [updated] = await db
    .update(workflowRun)
    .set({ status: "failed", error, completedAt: sql`now()` })
    .where(and(eq(workflowRun.id, runId), inArray(workflowRun.status, [...OPEN_RUN_STATUSES])))
    .returning();
  if (updated) {
    await writeAuditEvent(db, {
      actor: "system",
      action: "run.completed",
      targetType: "workflow_run",
      targetId: runId,
      outcome: "failed",
      reason: error,
    });
  }
}

// ---------------------------------------------------------------------------
// workflow.launch
// ---------------------------------------------------------------------------

export function createWorkflowLaunchHandler(deps: {
  db: Db;
  phoenixClient: PhoenixClient;
}): JobHandlerDefinition {
  const { db, phoenixClient } = deps;

  return defineJobHandler({
    type: "workflow.launch",
    async handle(job: OpsJobRow, lease: ActiveJobLease) {
      const runId = stringField(job.payload, "runId");
      const callbackToken = stringField(job.payload, "callbackToken");
      if (!runId || !callbackToken) {
        throw new TerminalJobError(
          `workflow.launch payload missing runId/callbackToken: ${JSON.stringify(job.payload)}`,
        );
      }

      const run = await loadRun(db, runId);
      if (!run) {
        throw new TerminalJobError(`workflow.launch: run ${runId} not found`);
      }
      // Not 'pending' means a previous attempt already launched this run (or
      // it moved on some other way) — replaying the launch is a no-op, not
      // an error. The run intentionally stays 'pending' for the entire
      // launch flow below (across retries too): dispatch idempotency, not a
      // status flag, is what protects against duplicate thread creation.
      if (run.status !== "pending") {
        // The status flip to 'running' and the watch enqueue below are two
        // statements; a crash between them leaves a running run with no
        // watch job, and this early return is where that replay lands. The
        // enqueue is idempotent on `watch:{runId}:1`, so re-asserting it
        // costs nothing when the chain is alive and repairs it when it
        // isn't. Without this the run would never be watched, and its
        // timeout would fall to `sweepExpiredRuns` an hour later.
        if (run.status === "running" && run.phoenixThreadId) {
          await enqueueWatch(db, runId, 1);
        }
        return { skipped: true, status: run.status };
      }

      const workflowRow = await loadWorkflow(db, run.workflowKey);
      if (!workflowRow) {
        throw new TerminalJobError(
          `workflow.launch: workflow "${run.workflowKey}" not found for run ${runId}`,
        );
      }

      if (run.mode === "fake") {
        const [completed] = await db
          .update(workflowRun)
          .set({
            status: "succeeded",
            result: { fake: true, input: run.input ?? null },
            startedAt: sql`now()`,
            completedAt: sql`now()`,
          })
          .where(and(eq(workflowRun.id, runId), eq(workflowRun.status, "pending")))
          .returning();
        if (completed) {
          await writeAuditEvent(db, {
            actor: "system",
            action: "run.completed",
            targetType: "workflow_run",
            targetId: runId,
            outcome: "succeeded",
            metadata: { mode: "fake" },
          });
        }
        return { fake: true };
      }

      const projectId = config.PHOENIX_PROJECT_ID;
      if (!projectId) {
        // Terminal for the job, so it must be terminal for the run too —
        // otherwise the job dead-letters and the run sits 'pending' with
        // nothing left to move it.
        await failRunTerminally(db, runId, "PHOENIX_PROJECT_ID is not configured");
        throw new TerminalJobError("workflow.launch: PHOENIX_PROJECT_ID is not configured");
      }

      const ids = deriveRunPhoenixIds(runId);
      const skillMarkdown = await loadSkillMarkdown(workflowRow.skillPath);
      const callbackUrl = `${config.BIRDHOUSE_PUBLIC_URL.replace(/\/+$/, "")}/api/runs/${runId}/result`;
      const promptText = buildRunPrompt({
        workflow: { key: workflowRow.key, title: workflowRow.title },
        run: { id: runId, mode: run.mode, input: run.input },
        skillMarkdown,
        callbackUrl,
        callbackToken,
      });

      const launchSettings = resolvePhoenixLaunchSettings(workflowRow.manifest);

      const createCommand = phoenixClient.createThread({
        commandId: ids.createCommandId,
        threadId: ids.threadId,
        projectId,
        title: `${workflowRow.title} — run ${runId}`,
        modelSelection: {
          instanceId: launchSettings.providerInstanceId,
          model: launchSettings.model,
        },
        runtimeMode: launchSettings.runtimeMode,
      });

      try {
        await phoenixClient.dispatch(createCommand, { signal: lease.leaseLostSignal });
      } catch (error) {
        if (error instanceof PhoenixInvalidRequestError) {
          // A rejected commandId is permanently rejected (contract
          // §Idempotency) and these ids are derived, not regenerable — there
          // is no fresh retry to attempt, so the run fails outright.
          await failRunTerminally(db, runId, `thread.create rejected: ${error.message}`);
          throw new TerminalJobError(
            `workflow.launch: thread.create rejected for run ${runId}: ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }

      const turnCommand = phoenixClient.startTurn({
        commandId: ids.turnCommandId,
        threadId: ids.threadId,
        messageId: ids.messageId,
        text: promptText,
        runtimeMode: launchSettings.runtimeMode,
      });

      try {
        await phoenixClient.dispatch(turnCommand, { signal: lease.leaseLostSignal });
      } catch (error) {
        if (error instanceof PhoenixInvalidRequestError) {
          await failRunTerminally(db, runId, `thread.turn.start rejected: ${error.message}`);
          throw new TerminalJobError(
            `workflow.launch: thread.turn.start rejected for run ${runId}: ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }

      // Both stamped from the database clock: `timeout_at` is compared
      // against `now()` by the watch handler and by `sweepExpiredRuns`, so
      // writing it from the JS clock would make a run's real budget depend on
      // this host's skew.
      const timeoutMs = resolveWorkflowTimeoutMs(workflowRow.manifest);

      await db
        .update(workflowRun)
        .set({
          status: "running",
          startedAt: sql`now()`,
          phoenixThreadId: ids.threadId,
          timeoutAt: sql`now() + (${timeoutMs} * interval '1 millisecond')`,
        })
        .where(and(eq(workflowRun.id, runId), eq(workflowRun.status, "pending")));

      await enqueueWatch(db, runId, 1);

      await writeAuditEvent(db, {
        actor: "system",
        action: "run.launched",
        targetType: "workflow_run",
        targetId: runId,
        outcome: "succeeded",
        metadata: { threadId: ids.threadId },
      });

      return { threadId: ids.threadId };
    },
  });
}

// ---------------------------------------------------------------------------
// workflow.watch
// ---------------------------------------------------------------------------

async function rescheduleWatch(
  db: Db,
  runId: string,
  attempt: number,
): Promise<Record<string, unknown>> {
  const next = attempt + 1;
  await enqueueWatch(db, runId, next);
  return { rescheduled: next };
}

function latestTerminalReport(detail: PhoenixThreadDetail) {
  for (let i = detail.reports.length - 1; i >= 0; i -= 1) {
    const report = detail.reports[i]!;
    if (report.status === "success" || report.status === "failure") return report;
  }
  return undefined;
}

export function createWorkflowWatchHandler(deps: {
  db: Db;
  phoenixClient: PhoenixClient;
}): JobHandlerDefinition {
  const { db, phoenixClient } = deps;

  return defineJobHandler({
    type: "workflow.watch",
    async handle(job: OpsJobRow, lease: ActiveJobLease) {
      const runId = stringField(job.payload, "runId");
      if (!runId) {
        throw new TerminalJobError(
          `workflow.watch payload missing runId: ${JSON.stringify(job.payload)}`,
        );
      }
      const attempt =
        typeof job.payload.attempt === "number" && Number.isFinite(job.payload.attempt)
          ? job.payload.attempt
          : 1;

      const run = await loadRun(db, runId);
      if (!run) {
        throw new TerminalJobError(`workflow.watch: run ${runId} not found`);
      }
      if (isTerminalRunStatus(run.status)) {
        return { alreadyTerminal: run.status };
      }
      if (run.status !== "running" || !run.phoenixThreadId) {
        // The launch handler hasn't recorded a thread yet. Shouldn't happen
        // in the normal flow (watch is only enqueued after that write), but
        // a crash between the two writes is conceivable; just check again
        // later rather than erroring.
        return rescheduleWatch(db, runId, attempt);
      }

      // (a) Timeout first, before any Phoenix call. The deadline is ours to
      // enforce and needs nothing from Phoenix, so checking it here keeps it
      // working when Phoenix is exactly what's broken: a deleted thread
      // (404) or an expired token (401) makes `getThread` throw on every
      // attempt until this job dead-letters, and a run whose deadline passed
      // in the meantime would never be marked timed out. Compared against
      // the database clock, same discipline as the job queue.
      const [timedOut] = await db
        .update(workflowRun)
        .set({ status: "timed_out", completedAt: sql`now()` })
        .where(
          and(
            eq(workflowRun.id, runId),
            eq(workflowRun.status, "running"),
            sql`${workflowRun.timeoutAt} is not null and now() > ${workflowRun.timeoutAt}`,
          ),
        )
        .returning();
      if (timedOut) {
        // The run is terminal now, but its agent session is still live on the
        // Phoenix side. Stopping it is durable work with its own retries, not
        // a best-effort call this job's success depends on.
        await enqueueStopSession(db, runId, run.phoenixThreadId);
        await writeAuditEvent(db, {
          actor: "system",
          action: "run.completed",
          targetType: "workflow_run",
          targetId: runId,
          outcome: "failed",
          reason: "timed_out",
        });
        return { timedOut: true };
      }

      const detail = await phoenixClient.getThread(run.phoenixThreadId, {
        signal: lease.leaseLostSignal,
      });

      // (b) A terminal report is best-effort enrichment per the contract
      // notes, but if the callback never arrives it is also the only signal
      // we have — ingest it and complete the run from it.
      const report = latestTerminalReport(detail);
      if (report) {
        const outcome = report.status === "success" ? "succeeded" : "failed";
        const [updated] = await db
          .update(workflowRun)
          .set({
            status: outcome,
            completedAt: sql`now()`,
            result: { report, completedVia: "report" },
            ...(outcome === "failed" ? { error: report.title } : {}),
          })
          .where(and(eq(workflowRun.id, runId), eq(workflowRun.status, "running")))
          .returning();
        if (updated) {
          await writeAuditEvent(db, {
            actor: "system",
            action: "run.completed",
            targetType: "workflow_run",
            targetId: runId,
            outcome,
            metadata: { completedVia: "report", reportId: report.reportId },
          });
          return { completedVia: "report" };
        }
        // Lost the race to the HTTP callback completing the run first —
        // nothing left to do.
        return { alreadyTerminal: true };
      }

      // (c) The turn itself errored out with no report ever posted.
      if (detail.latestTurn?.state === "error") {
        const [updated] = await db
          .update(workflowRun)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            error: "Phoenix turn ended in error state",
          })
          .where(and(eq(workflowRun.id, runId), eq(workflowRun.status, "running")))
          .returning();
        if (updated) {
          await writeAuditEvent(db, {
            actor: "system",
            action: "run.completed",
            targetType: "workflow_run",
            targetId: runId,
            outcome: "failed",
            reason: "turn_error",
          });
          return { failedVia: "turn_error" };
        }
        return { alreadyTerminal: true };
      }

      // (d) Still running — check again next interval.
      return rescheduleWatch(db, runId, attempt);
    },
  });
}

// ---------------------------------------------------------------------------
// workflow.stop
// ---------------------------------------------------------------------------

/**
 * Stops the Phoenix session behind a run that has already gone terminal
 * without the agent finishing — a timeout, whether caught by the watch job
 * or by `sweepExpiredRuns`. Its own job rather than an inline best-effort
 * call so a transient failure is retried instead of silently leaving an
 * agent session running against the box's provider quota.
 */
export function createWorkflowStopHandler(deps: {
  db: Db;
  phoenixClient: PhoenixClient;
}): JobHandlerDefinition {
  const { phoenixClient } = deps;

  return defineJobHandler({
    type: "workflow.stop",
    async handle(job: OpsJobRow, lease: ActiveJobLease) {
      const threadId = stringField(job.payload, "threadId");
      if (!threadId) {
        throw new TerminalJobError(
          `workflow.stop payload missing threadId: ${JSON.stringify(job.payload)}`,
        );
      }
      await phoenixClient.stopSession(
        threadId,
        { stopReason: "parent_stopped", stoppedBy: "system" },
        { signal: lease.leaseLostSignal },
      );
      return { stopped: threadId };
    },
  });
}
