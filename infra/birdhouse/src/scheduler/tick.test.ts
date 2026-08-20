import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { CreateWorkflowRunInput, CreateWorkflowRunResult } from "../runner/runs.ts";
import { workflowSchedule, workflow } from "../db/schema.ts";
import { runSchedulerTick } from "./tick.ts";

/**
 * Reads `next_run_at`/`last_enqueued_at` back via epoch extraction rather
 * than a typed `select` — see tick.ts's `claimDueSchedules` comment: `pg`'s
 * default parser for these tz-naive `timestamp` columns reinterprets the
 * stored wall-clock text through the *test runner's* local time zone, so a
 * plain `select` would make this assertion pass or fail depending on the
 * machine's TZ rather than on the code under test.
 */
async function readScheduleTimestamps(
  db: ReturnType<typeof drizzle>,
  scheduleId: string,
): Promise<{ nextRunAtMs: number | null; lastEnqueuedAtMs: number | null }> {
  const result = await db.execute<{
    next_run_at_ms: string | null;
    last_enqueued_at_ms: string | null;
  }>(sql`
    select extract(epoch from next_run_at) * 1000 as next_run_at_ms,
           extract(epoch from last_enqueued_at) * 1000 as last_enqueued_at_ms
    from workflow_schedule
    where id = ${scheduleId}
  `);
  const row = result.rows[0];
  return {
    nextRunAtMs: row?.next_run_at_ms == null ? null : Number(row.next_run_at_ms),
    lastEnqueuedAtMs: row?.last_enqueued_at_ms == null ? null : Number(row.last_enqueued_at_ms),
  };
}

// The claim logic (transactional select-and-advance) is a set of concurrent
// SQL statements racing against real `for update skip locked` rows — worth
// exercising against Postgres rather than trusting the query builder
// produced what the raw SQL intends. Same rationale as jobs/queue.test.ts.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("runSchedulerTick", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });

  afterAll(async () => {
    await pool.end();
  });

  it("claims a due schedule, starts a run, advances next_run_at, and claims nothing on the next tick", async () => {
    const workflowKey = `test-tick-${randomUUID()}`;

    // syncedAt intentionally left unset: this row was never disk-synced, so
    // the tick's disk-reconciliation step must leave it alone even though
    // the fixture workflows dir below is empty (and would otherwise read as
    // "every synced workflow just vanished from disk").
    await db.insert(workflow).values({
      key: workflowKey,
      title: "Test tick workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
    });

    // Daily, not every-minute: the assertions below check that the
    // advanced next_run_at lands comfortably in the future relative to
    // whenever this test happens to run, which a tight every-minute cron
    // can't guarantee without racing the clock.
    const due = new Date(Date.now() - 120_000);
    const [schedule] = await db
      .insert(workflowSchedule)
      .values({
        workflowKey,
        cron: "0 0 * * *",
        timezone: "Europe/London",
        nextRunAt: due,
      })
      .returning();
    expect(schedule).toBeDefined();

    const emptyWorkflowsDir = await mkdtemp(join(tmpdir(), "ops-workflows-empty-"));

    const calls: CreateWorkflowRunInput[] = [];
    const createRun = async (input: CreateWorkflowRunInput): Promise<CreateWorkflowRunResult> => {
      calls.push(input);
      return { runId: randomUUID(), created: true };
    };

    const first = await runSchedulerTick({
      db,
      workflowsDir: emptyWorkflowsDir,
      defaultTimezone: "Europe/London",
      createRun,
    });
    expect(first.schedulesClaimed).toBe(1);
    expect(first.runsStarted).toBe(1);
    expect(first.runsFailed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.workflowKey).toBe(workflowKey);
    expect(calls[0]?.trigger).toBe("schedule");
    expect(calls[0]?.dedupeKey).toMatch(
      new RegExp(`^schedule:${schedule!.id}:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`),
    );

    const updated = await readScheduleTimestamps(db, schedule!.id);
    expect(updated.nextRunAtMs).not.toBeNull();
    expect(updated.nextRunAtMs!).toBeGreaterThan(due.getTime());
    expect(updated.nextRunAtMs!).toBeGreaterThan(Date.now());
    expect(updated.lastEnqueuedAtMs).not.toBeNull();

    const second = await runSchedulerTick({
      db,
      workflowsDir: emptyWorkflowsDir,
      defaultTimezone: "Europe/London",
      createRun,
    });
    expect(second.schedulesClaimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("fires a backlogged schedule once and resumes from the present", async () => {
    const workflowKey = `test-tick-backlog-${randomUUID()}`;
    await db.insert(workflow).values({
      key: workflowKey,
      title: "Backlogged workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
    });

    // Hourly, last fired three days ago: the shape left behind by downtime.
    // Stepping one occurrence per claim would work through ~72 stale
    // occurrences, each starting a real agent run.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const [schedule] = await db
      .insert(workflowSchedule)
      .values({
        workflowKey,
        cron: "0 * * * *",
        timezone: "Europe/London",
        nextRunAt: threeDaysAgo,
      })
      .returning();

    const emptyWorkflowsDir = await mkdtemp(join(tmpdir(), "ops-workflows-empty-"));
    const calls: CreateWorkflowRunInput[] = [];
    const createRun = async (input: CreateWorkflowRunInput): Promise<CreateWorkflowRunResult> => {
      calls.push(input);
      return { runId: randomUUID(), created: true };
    };

    const first = await runSchedulerTick({
      db,
      workflowsDir: emptyWorkflowsDir,
      defaultTimezone: "Europe/London",
      createRun,
    });
    expect(first.schedulesClaimed).toBe(1);

    // Advanced past now, not to the next of the 72 missed occurrences.
    const updated = await readScheduleTimestamps(db, schedule!.id);
    expect(updated.nextRunAtMs!).toBeGreaterThan(Date.now());

    const second = await runSchedulerTick({
      db,
      workflowsDir: emptyWorkflowsDir,
      defaultTimezone: "Europe/London",
      createRun,
    });
    expect(second.schedulesClaimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does not claim a due schedule of a disabled workflow", async () => {
    const workflowKey = `test-tick-disabled-${randomUUID()}`;
    await db.insert(workflow).values({
      key: workflowKey,
      title: "Disabled workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
      enabled: false,
    });
    await db.insert(workflowSchedule).values({
      workflowKey,
      cron: "* * * * *",
      timezone: "Europe/London",
      nextRunAt: new Date(Date.now() - 60_000),
    });

    const emptyWorkflowsDir = await mkdtemp(join(tmpdir(), "ops-workflows-empty-"));
    const calls: CreateWorkflowRunInput[] = [];
    const summary = await runSchedulerTick({
      db,
      workflowsDir: emptyWorkflowsDir,
      defaultTimezone: "Europe/London",
      createRun: async (input) => {
        calls.push(input);
        return { runId: randomUUID(), created: true };
      },
    });

    expect(summary.schedulesClaimed).toBe(0);
    expect(calls).toEqual([]);
  });
});
