import type { Db } from "../db/client.ts";

/**
 * One pass of the scheduler: find `workflow_schedule` rows due to fire
 * (`enabled` and `next_run_at <= now()`), enqueue an `ops_job` + matching
 * `workflow_run` for each, and advance `next_run_at` to the schedule's next
 * occurrence (via `croner`).
 *
 * Not implemented yet — this is a seam so `cli.ts`'s worker command has a
 * stable place to call from once `OPS_SCHEDULER_TICK_MS` starts driving a
 * real tick, without this wave's job queue depending on the scheduler wave.
 *
 * TODO(scheduler): implement once `workflow` / `workflow_schedule` are
 * populated from disk manifests.
 */
export async function runSchedulerTick(db: Db): Promise<void> {
  void db;
  throw new Error("runSchedulerTick is not implemented yet");
}
