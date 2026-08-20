import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { workflow, workflowSchedule } from "../db/schema.ts";
import { nextCronOccurrence } from "../lib/cron.ts";
// Type-only: the runner module (which this imports for real, lazily, below)
// pulls in config.ts, which validates OPS_DATABASE_URL eagerly at import
// time. A static value import here would force every caller — including
// this module's own unit tests, which inject a stub `createRun` and never
// need the real one — to have a database configured just to load the file.
import type { CreateWorkflowRunInput, CreateWorkflowRunResult } from "../runner/runs.ts";
import {
  loadWorkflowDefinitions,
  resolveWorkflowsDir,
  syncWorkflows,
} from "../workflows/loader.ts";

export type CreateWorkflowRunFn = (
  input: CreateWorkflowRunInput,
) => Promise<CreateWorkflowRunResult>;

type ClaimedSchedule = Readonly<{
  id: string;
  workflowKey: string;
  cron: string;
  timezone: string;
  /** The `next_run_at` value that was due — the occurrence being fired. */
  occurrence: Date;
}>;

/**
 * Selects due, enabled schedules of enabled workflows and advances each to
 * its next occurrence, all inside one transaction with `for update skip
 * locked` — the same discipline as the job queue's leasing — so two
 * scheduler instances can never claim the same firing twice. Comparisons
 * run in SQL against `now()`, never a JS clock (see queue.ts).
 */
async function claimDueSchedules(db: Db): Promise<ClaimedSchedule[]> {
  return db.transaction(async (tx) => {
    const due = await tx.execute<{
      id: string;
      workflow_key: string;
      cron: string;
      timezone: string;
      // `next_run_at` is a `timestamp` (no time zone) column, so `pg`'s
      // default parser reads the naive wall-clock text back through the
      // *Node process's* local time zone rather than UTC — invisible when
      // the process happens to run with TZ=UTC, silently off by the host's
      // offset otherwise. Extracting the epoch sidesteps that parser
      // entirely; every other query in this file compares the column in SQL
      // only (never materializing it as a JS Date), which is unaffected.
      next_run_at_epoch_ms: string;
    }>(sql`
      select ${workflowSchedule.id} as id,
             ${workflowSchedule.workflowKey} as workflow_key,
             ${workflowSchedule.cron} as cron,
             ${workflowSchedule.timezone} as timezone,
             extract(epoch from ${workflowSchedule.nextRunAt}) * 1000 as next_run_at_epoch_ms
      from ${workflowSchedule}
      join ${workflow} on ${workflow.key} = ${workflowSchedule.workflowKey}
      where ${workflowSchedule.enabled} = true
        and ${workflow.enabled} = true
        and ${workflowSchedule.nextRunAt} is not null
        and ${workflowSchedule.nextRunAt} <= now()
      for update of ${workflowSchedule} skip locked
    `);

    const claimed: ClaimedSchedule[] = [];
    for (const row of due.rows) {
      const occurrence = new Date(Number(row.next_run_at_epoch_ms));
      const next = nextCronOccurrence(row.cron, row.timezone, occurrence);
      await tx
        .update(workflowSchedule)
        .set({ nextRunAt: next, lastEnqueuedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(workflowSchedule.id, row.id));
      claimed.push({
        id: row.id,
        workflowKey: row.workflow_key,
        cron: row.cron,
        timezone: row.timezone,
        occurrence,
      });
    }
    return claimed;
  });
}

export type SchedulerTickSummary = Readonly<{
  workflowsSynced: number;
  workflowLoadErrors: number;
  schedulesClaimed: number;
  runsStarted: number;
  runsFailed: number;
}>;

export type RunSchedulerTickInput = Readonly<{
  db: Db;
  /** Defaults to `resolveWorkflowsDir(config.OPS_WORKFLOWS_DIR)`; pass explicitly in tests to avoid needing `OPS_DATABASE_URL`. */
  workflowsDir?: string;
  /** Defaults to `config.OPS_TIMEZONE`. */
  defaultTimezone?: string;
  /** Injection seam for tests; defaults to the real `createWorkflowRun`. */
  createRun?: CreateWorkflowRunFn;
}>;

/**
 * One pass of the scheduler: sync workflow definitions from disk (cheap at
 * this scale — every tick is fine), claim whatever schedules are due, and
 * start a run for each. A schedule whose run fails to start is logged and
 * skipped rather than aborting the rest of the tick; it already advanced
 * past this occurrence, so its next due firing is its next chance.
 */
export async function runSchedulerTick(
  input: RunSchedulerTickInput,
): Promise<SchedulerTickSummary> {
  const { db } = input;
  let workflowsDir = input.workflowsDir;
  let defaultTimezone = input.defaultTimezone;
  if (workflowsDir === undefined || defaultTimezone === undefined) {
    const { config } = await import("../config.ts");
    workflowsDir ??= resolveWorkflowsDir(config.OPS_WORKFLOWS_DIR);
    defaultTimezone ??= config.OPS_TIMEZONE;
  }
  const createRun = input.createRun ?? (await import("../runner/runs.ts")).createWorkflowRun;

  const { definitions, errors: loadErrors } = await loadWorkflowDefinitions(workflowsDir, {
    defaultTimezone,
  });
  if (loadErrors.length > 0) {
    console.warn(JSON.stringify({ event: "workflows.load_errors", errors: loadErrors }));
  }
  const syncSummary = await syncWorkflows(db, definitions);

  const claimed = await claimDueSchedules(db);
  let runsStarted = 0;
  let runsFailed = 0;
  for (const claim of claimed) {
    const occurrenceIso = claim.occurrence.toISOString();
    try {
      await createRun({
        db,
        workflowKey: claim.workflowKey,
        trigger: "schedule",
        dedupeKey: `schedule:${claim.id}:${occurrenceIso}`,
      });
      runsStarted += 1;
    } catch (error) {
      runsFailed += 1;
      console.error(
        JSON.stringify({
          event: "scheduler.run_start_failed",
          scheduleId: claim.id,
          workflowKey: claim.workflowKey,
          occurrence: occurrenceIso,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const summary: SchedulerTickSummary = {
    workflowsSynced: syncSummary.workflowsUpserted,
    workflowLoadErrors: loadErrors.length,
    schedulesClaimed: claimed.length,
    runsStarted,
    runsFailed,
  };
  console.log(JSON.stringify({ event: "scheduler.tick", ...summary }));
  return summary;
}

export type StartSchedulerLoopInput = Readonly<{
  db: Db;
  signal?: AbortSignal;
  /** Defaults to `config.OPS_SCHEDULER_TICK_MS`. */
  tickMs?: number;
  workflowsDir?: string;
  defaultTimezone?: string;
  createRun?: CreateWorkflowRunFn;
}>;

/** Resolves `ms` early if `signal` aborts while waiting, so shutdown isn't delayed by a stale timer (mirrors jobs/queue.ts). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });
}

/**
 * Runs `runSchedulerTick` on a fixed cadence, one tick at a time — the next
 * tick is never scheduled until the previous one settles — until `signal`
 * aborts. A tick that throws is logged and does not stop the loop; the
 * scheduler gets another chance next cadence.
 */
export async function startSchedulerLoop(input: StartSchedulerLoopInput): Promise<void> {
  const { db, signal } = input;
  const tickMs = input.tickMs ?? (await import("../config.ts")).config.OPS_SCHEDULER_TICK_MS;
  const tickInput: RunSchedulerTickInput = {
    db,
    ...(input.workflowsDir !== undefined ? { workflowsDir: input.workflowsDir } : {}),
    ...(input.defaultTimezone !== undefined ? { defaultTimezone: input.defaultTimezone } : {}),
    ...(input.createRun !== undefined ? { createRun: input.createRun } : {}),
  };

  while (!signal?.aborted) {
    try {
      await runSchedulerTick(tickInput);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scheduler.tick_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await sleep(tickMs, signal);
  }
}
