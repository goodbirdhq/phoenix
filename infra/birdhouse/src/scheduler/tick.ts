import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { workflow, workflowSchedule } from "../db/schema.ts";
import { nextCronOccurrence } from "../lib/cron.ts";
// Type-only: the runner module (which this imports for real, lazily, below)
// pulls in config.ts, which validates BIRDHOUSE_DATABASE_URL eagerly at import
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

export type SweepExpiredRunsFn = (db: Db) => Promise<{ timedOut: number }>;

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
    // One read of the database clock for the whole claim, so every advance in
    // this transaction is measured from the same instant (and from Postgres's
    // clock, not the host's).
    const clock = await tx.execute<{ now_epoch_ms: string }>(
      sql`select extract(epoch from now()) * 1000 as now_epoch_ms`,
    );
    const nowEpochMs = clock.rows[0]?.now_epoch_ms ?? String(Date.now());

    const due = await tx.execute<{
      id: string;
      workflow_key: string;
      cron: string;
      timezone: string;
      // Read as an epoch rather than letting `pg` hand back a Date: the
      // value is only ever used as an instant to compute the next cron
      // occurrence from, and going through the epoch keeps that arithmetic
      // independent of the driver's parsing and the process's local zone.
      // Every other query here compares the column in SQL only.
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
    const claimedAt = new Date(Number(nowEpochMs));
    for (const row of due.rows) {
      const occurrence = new Date(Number(row.next_run_at_epoch_ms));
      // Advance from now, not from the occurrence we just fired. Stepping one
      // occurrence at a time replays the whole backlog after any downtime:
      // an every-15-minutes schedule that was down for a day would fire ~96
      // real agent runs, one per tick, for occurrences long past. A missed
      // window is a missed window — fire once for it, then resume the
      // schedule from the present.
      const next = nextCronOccurrence(
        row.cron,
        row.timezone,
        occurrence > claimedAt ? occurrence : claimedAt,
      );
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
  /** Open runs past their deadline that this tick retired. */
  runsTimedOut: number;
}>;

export type RunSchedulerTickInput = Readonly<{
  db: Db;
  /** Defaults to `resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR)`; pass explicitly in tests to avoid needing `BIRDHOUSE_DATABASE_URL`. */
  workflowsDir?: string;
  /** Defaults to `config.BIRDHOUSE_TIMEZONE`. */
  defaultTimezone?: string;
  /** Injection seam for tests; defaults to the real `createWorkflowRun`. */
  createRun?: CreateWorkflowRunFn;
  /** Injection seam for tests; defaults to the real `sweepExpiredRuns`. */
  sweepRuns?: SweepExpiredRunsFn;
}>;

/**
 * One pass of the scheduler: sync workflow definitions from disk, retire any
 * run that has outlived its deadline, claim whatever schedules are due, and
 * start a run for each. A schedule whose run fails to start is logged and
 * skipped rather than aborting the rest of the tick; it already advanced
 * past this occurrence, so its next due firing is its next chance.
 *
 * The sweep lives here, on a cadence outside the job chain, precisely
 * because it exists to cover for that chain breaking — see
 * `sweepExpiredRuns`.
 */
export async function runSchedulerTick(
  input: RunSchedulerTickInput,
): Promise<SchedulerTickSummary> {
  const { db } = input;
  let workflowsDir = input.workflowsDir;
  let defaultTimezone = input.defaultTimezone;
  if (workflowsDir === undefined || defaultTimezone === undefined) {
    const { config } = await import("../config.ts");
    workflowsDir ??= resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR);
    defaultTimezone ??= config.BIRDHOUSE_TIMEZONE;
  }
  const runsModule =
    input.createRun === undefined || input.sweepRuns === undefined
      ? await import("../runner/runs.ts")
      : undefined;
  const createRun = input.createRun ?? runsModule!.createWorkflowRun;
  const sweepRuns = input.sweepRuns ?? runsModule!.sweepExpiredRuns;

  const { definitions, errors: loadErrors } = await loadWorkflowDefinitions(workflowsDir, {
    defaultTimezone,
  });
  if (loadErrors.length > 0) {
    console.warn(JSON.stringify({ event: "workflows.load_errors", errors: loadErrors }));
  }
  // Only reconcile against disk when this load saw all of it; see syncWorkflows.
  const syncSummary = await syncWorkflows(db, definitions, {
    reconcileMissing: loadErrors.length === 0,
  });

  // Before claiming new work: a stuck run holds no lock, but retiring it
  // promptly is what keeps `timeout_at` meaningful.
  let runsTimedOut = 0;
  try {
    runsTimedOut = (await sweepRuns(db)).timedOut;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "scheduler.sweep_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

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
    runsTimedOut,
  };
  console.log(JSON.stringify({ event: "scheduler.tick", ...summary }));
  return summary;
}

export type StartSchedulerLoopInput = Readonly<{
  db: Db;
  signal?: AbortSignal;
  /** Defaults to `config.BIRDHOUSE_SCHEDULER_TICK_MS`. */
  tickMs?: number;
  workflowsDir?: string;
  defaultTimezone?: string;
  createRun?: CreateWorkflowRunFn;
  sweepRuns?: SweepExpiredRunsFn;
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
  const tickMs = input.tickMs ?? (await import("../config.ts")).config.BIRDHOUSE_SCHEDULER_TICK_MS;
  const tickInput: RunSchedulerTickInput = {
    db,
    ...(input.workflowsDir !== undefined ? { workflowsDir: input.workflowsDir } : {}),
    ...(input.defaultTimezone !== undefined ? { defaultTimezone: input.defaultTimezone } : {}),
    ...(input.createRun !== undefined ? { createRun: input.createRun } : {}),
    ...(input.sweepRuns !== undefined ? { sweepRuns: input.sweepRuns } : {}),
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
