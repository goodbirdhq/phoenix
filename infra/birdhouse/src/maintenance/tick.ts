import type { Db } from "../db/client.ts";
// Type-only: the runner module (which this imports for real, lazily, below)
// pulls in config.ts, which validates BIRDHOUSE_DATABASE_URL eagerly at import
// time. A static value import here would force every caller — including
// this module's own unit tests, which inject a stub `sweepRuns` and never
// need the real one — to have a database configured just to load the file.
import {
  loadWorkflowDefinitions,
  resolveWorkflowsDir,
  syncWorkflows,
} from "../workflows/loader.ts";

export type SweepExpiredRunsFn = (db: Db) => Promise<{ timedOut: number }>;

export type MaintenanceTickSummary = Readonly<{
  workflowsSynced: number;
  workflowLoadErrors: number;
  /** Open runs past their deadline that this tick retired. */
  runsTimedOut: number;
}>;

export type RunMaintenanceTickInput = Readonly<{
  db: Db;
  /** Defaults to `resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR)`; pass explicitly in tests to avoid needing `BIRDHOUSE_DATABASE_URL`. */
  workflowsDir?: string;
  /** Injection seam for tests; defaults to the real `sweepExpiredRuns`. */
  sweepRuns?: SweepExpiredRunsFn;
  /** Defaults to `config.BIRDHOUSE_JOB_RETENTION_DAYS`; 0 disables pruning. */
  jobRetentionDays?: number;
}>;

/**
 * One pass of maintenance: sync workflow definitions from disk, retire any
 * run that has outlived its deadline, and prune old finished jobs. Nothing
 * here starts a run — Phoenix Schedules own firing an agent thread now, and
 * that thread claims its own run via `POST /api/workflows/:key/claim` (see
 * runner/runs.ts's `claimWorkflowRun`).
 *
 * The sweep lives here, on a cadence outside the job chain, precisely
 * because it exists to cover for that chain breaking — see
 * `sweepExpiredRuns`.
 */
export async function runMaintenanceTick(
  input: RunMaintenanceTickInput,
): Promise<MaintenanceTickSummary> {
  const { db } = input;
  let workflowsDir = input.workflowsDir;
  let retentionDays = input.jobRetentionDays;
  if (workflowsDir === undefined || retentionDays === undefined) {
    const { config } = await import("../config.ts");
    workflowsDir ??= resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR);
    retentionDays ??= config.BIRDHOUSE_JOB_RETENTION_DAYS;
  }
  const sweepRuns = input.sweepRuns ?? (await import("../runner/runs.ts")).sweepExpiredRuns;

  const { definitions, errors: loadErrors } = await loadWorkflowDefinitions(workflowsDir);
  if (loadErrors.length > 0) {
    console.warn(JSON.stringify({ event: "workflows.load_errors", errors: loadErrors }));
  }
  // Only reconcile against disk when this load saw all of it; see syncWorkflows.
  const syncSummary = await syncWorkflows(db, definitions, {
    reconcileMissing: loadErrors.length === 0,
  });

  let runsTimedOut = 0;
  try {
    runsTimedOut = (await sweepRuns(db)).timedOut;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "maintenance.sweep_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  if (retentionDays > 0) {
    try {
      const { pruneTerminalJobs } = await import("../jobs/queue.ts");
      await pruneTerminalJobs({ db, retentionDays });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "maintenance.prune_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const summary: MaintenanceTickSummary = {
    workflowsSynced: syncSummary.workflowsUpserted,
    workflowLoadErrors: loadErrors.length,
    runsTimedOut,
  };
  console.log(JSON.stringify({ event: "maintenance.tick", ...summary }));
  return summary;
}

export type StartMaintenanceLoopInput = Readonly<{
  db: Db;
  signal?: AbortSignal;
  /** Defaults to `config.BIRDHOUSE_MAINTENANCE_TICK_MS`. */
  tickMs?: number;
  workflowsDir?: string;
  sweepRuns?: SweepExpiredRunsFn;
  jobRetentionDays?: number;
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
 * Runs `runMaintenanceTick` on a fixed cadence, one tick at a time — the next
 * tick is never scheduled until the previous one settles — until `signal`
 * aborts. A tick that throws is logged and does not stop the loop; the loop
 * gets another chance next cadence.
 */
export async function startMaintenanceLoop(input: StartMaintenanceLoopInput): Promise<void> {
  const { db, signal } = input;
  const tickMs =
    input.tickMs ?? (await import("../config.ts")).config.BIRDHOUSE_MAINTENANCE_TICK_MS;
  const tickInput: RunMaintenanceTickInput = {
    db,
    ...(input.workflowsDir !== undefined ? { workflowsDir: input.workflowsDir } : {}),
    ...(input.sweepRuns !== undefined ? { sweepRuns: input.sweepRuns } : {}),
    ...(input.jobRetentionDays !== undefined ? { jobRetentionDays: input.jobRetentionDays } : {}),
  };

  while (!signal?.aborted) {
    try {
      await runMaintenanceTick(tickInput);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "maintenance.tick_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await sleep(tickMs, signal);
  }
}
