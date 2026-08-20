import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, inArray, sql } from "drizzle-orm";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { workflow, workflowRun } from "../db/schema.ts";
import { TerminalJobError } from "../jobs/errors.ts";
import { enqueueJob } from "../jobs/queue.ts";
import type { ActiveJobLease, JobHandlerDefinition, OpsJobRow } from "../jobs/types.ts";
import { defineJobHandler } from "../jobs/types.ts";
import {
  PhoenixInvalidRequestError,
  type PhoenixClient,
  type PhoenixThreadDetail,
} from "../phoenix/client.ts";
import { writeAuditEvent } from "./audit.ts";
import { deriveRunPhoenixIds } from "./ids.ts";
import { buildRunPrompt } from "./prompt.ts";
import { resolveWorkflowTimeoutMs } from "./runs.ts";

// infra/birdhouse/src/runner/handlers.ts -> package root (infra/birdhouse) is two
// directories up.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// `workflow.skill_path` is stored relative to the workflows root
// (`BIRDHOUSE_WORKFLOWS_DIR`), not the package root directly — confirmed against
// src/workflows/loader.ts's `WorkflowDefinition.skillPath` doc comment
// ("relative to the workflows root"). `BIRDHOUSE_WORKFLOWS_DIR` itself resolves
// against the package root when relative (see src/config.ts). Reimplemented
// locally rather than imported from src/workflows/loader.ts (owned by a
// concurrent wave) to stay decoupled from its in-flight API.
function resolveWorkflowsRoot(): string {
  return isAbsolute(config.BIRDHOUSE_WORKFLOWS_DIR)
    ? config.BIRDHOUSE_WORKFLOWS_DIR
    : resolve(PACKAGE_ROOT, config.BIRDHOUSE_WORKFLOWS_DIR);
}

async function loadSkillMarkdown(skillPath: string): Promise<string> {
  const resolved = isAbsolute(skillPath) ? skillPath : resolve(resolveWorkflowsRoot(), skillPath);
  return readFile(resolved, "utf8");
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
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
  const now = new Date();
  const [updated] = await db
    .update(workflowRun)
    .set({ status: "failed", error, completedAt: now })
    .where(
      and(
        eq(workflowRun.id, runId),
        inArray(workflowRun.status, ["pending", "launching", "running"]),
      ),
    )
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
        return { skipped: true, status: run.status };
      }

      const workflowRow = await loadWorkflow(db, run.workflowKey);
      if (!workflowRow) {
        throw new TerminalJobError(
          `workflow.launch: workflow "${run.workflowKey}" not found for run ${runId}`,
        );
      }

      if (run.mode === "fake") {
        const now = new Date();
        const [completed] = await db
          .update(workflowRun)
          .set({
            status: "succeeded",
            result: { fake: true, input: run.input ?? null },
            startedAt: now,
            completedAt: now,
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

      const createCommand = phoenixClient.createThread({
        commandId: ids.createCommandId,
        threadId: ids.threadId,
        projectId,
        title: `${workflowRow.title} — run ${runId}`,
        modelSelection: {
          instanceId: config.PHOENIX_PROVIDER_INSTANCE_ID,
          model: config.PHOENIX_MODEL,
        },
        runtimeMode: config.PHOENIX_RUNTIME_MODE,
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
        runtimeMode: config.PHOENIX_RUNTIME_MODE,
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

      const startedAt = new Date();
      const timeoutMs = resolveWorkflowTimeoutMs(workflowRow.manifest);
      const timeoutAt = new Date(startedAt.getTime() + timeoutMs);

      await db
        .update(workflowRun)
        .set({
          status: "running",
          startedAt,
          phoenixThreadId: ids.threadId,
          timeoutAt,
        })
        .where(and(eq(workflowRun.id, runId), eq(workflowRun.status, "pending")));

      await enqueueJob({
        db,
        type: "workflow.watch",
        payload: { runId, attempt: 1 },
        idempotencyKey: `watch:${runId}:1`,
        runAfter: new Date(Date.now() + config.BIRDHOUSE_RUN_WATCH_INTERVAL_MS),
      });

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
  await enqueueJob({
    db,
    type: "workflow.watch",
    payload: { runId, attempt: next },
    idempotencyKey: `watch:${runId}:${next}`,
    runAfter: new Date(Date.now() + config.BIRDHOUSE_RUN_WATCH_INTERVAL_MS),
  });
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

      const detail = await phoenixClient.getThread(run.phoenixThreadId, {
        signal: lease.leaseLostSignal,
      });

      // (a) A terminal report is best-effort enrichment per the contract
      // notes, but if the callback never arrives it is also the only signal
      // we have — ingest it and complete the run from it.
      const report = latestTerminalReport(detail);
      if (report) {
        const outcome = report.status === "success" ? "succeeded" : "failed";
        const [updated] = await db
          .update(workflowRun)
          .set({
            status: outcome,
            completedAt: new Date(),
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

      // (b) The turn itself errored out with no report ever posted.
      if (detail.latestTurn?.state === "error") {
        const [updated] = await db
          .update(workflowRun)
          .set({
            status: "failed",
            completedAt: new Date(),
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

      // (c) Timeout — compared against the database clock, not JS's, same
      // discipline as the job queue's own due/lease comparisons.
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
        // Best-effort: the run is already terminal, so a stop failure must
        // not fail this job (a retry would no-op on the terminal run and the
        // stop would never be reattempted anyway).
        try {
          await phoenixClient.stopSession(
            run.phoenixThreadId,
            { stopReason: "parent_stopped", stoppedBy: "system" },
            { signal: lease.leaseLostSignal },
          );
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "run.stop_session_failed",
              runId,
              threadId: run.phoenixThreadId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
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

      // (d) Still running — check again next interval.
      return rescheduleWatch(db, runId, attempt);
    },
  });
}
