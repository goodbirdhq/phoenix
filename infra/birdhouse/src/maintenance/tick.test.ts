import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { opsJob, workflow, workflowRun } from "../db/schema.ts";
import { runMaintenanceTick } from "./tick.ts";

async function emptyWorkflowsDir(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ops-workflows-empty-"));
}

/** Writes one workflow subdirectory with a manifest + skill file, for a real disk-sync pass. */
async function writeWorkflow(root: string, key: string): Promise<void> {
  const dir = NodePath.join(root, key);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "manifest.json"),
    JSON.stringify({ key, title: `Test ${key}`, skill: "SKILL.md" }),
  );
  await NodeFSP.writeFile(NodePath.join(dir, "SKILL.md"), "# Skill\n");
}

// Nothing here claims or starts a run any more — Phoenix Schedules own
// firing an agent thread, which claims its own run via
// POST /api/workflows/:key/claim (runner/runs.ts's claimWorkflowRun). What
// survives on this cadence is manifest sync, the expired-run sweep, and job
// pruning — each exercised against a real Postgres, same rationale as
// jobs/queue.test.ts.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("runMaintenanceTick", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });

  afterAll(async () => {
    await pool.end();
  });

  it("syncs workflow definitions from disk", async () => {
    const workflowKey = `test-tick-sync-${NodeCrypto.randomUUID()}`;
    const root = await emptyWorkflowsDir();
    await writeWorkflow(root, workflowKey);

    const summary = await runMaintenanceTick({
      db,
      workflowsDir: root,
      jobRetentionDays: 0,
      sweepRuns: async () => ({ timedOut: 0 }),
    });

    expect(summary.workflowsSynced).toBe(1);
    expect(summary.workflowLoadErrors).toBe(0);

    const [row] = await db.select().from(workflow).where(eq(workflow.key, workflowKey)).limit(1);
    expect(row).toBeDefined();
    expect(row?.title).toBe(`Test ${workflowKey}`);
  });

  // The catastrophic version of this: one tick pointed at a mistyped
  // BIRDHOUSE_WORKFLOWS_DIR reads as "every workflow vanished", disables all
  // of them, and the upsert never writes `enabled` back — so fixing the path
  // fixes nothing and recovery is hand-written SQL.
  it("leaves synced workflows enabled when the workflows directory can't be read", async () => {
    const workflowKey = `test-tick-unreadable-${NodeCrypto.randomUUID()}`;
    await db.insert(workflow).values({
      key: workflowKey,
      title: "Synced workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
      // Disk-synced, so it is exactly the kind of row reconciliation disables.
      syncedAt: new Date(),
    });

    const missingDir = NodePath.join(await emptyWorkflowsDir(), "not-here");
    const summary = await runMaintenanceTick({
      db,
      workflowsDir: missingDir,
      jobRetentionDays: 0,
      sweepRuns: async () => ({ timedOut: 0 }),
    });

    expect(summary.workflowLoadErrors).toBe(1);
    const [row] = await db.select().from(workflow).where(eq(workflow.key, workflowKey)).limit(1);
    expect(row?.enabled).toBe(true);
  });

  it("sweeps a run past its deadline and reports it in the summary", async () => {
    const workflowKey = `test-tick-sweep-${NodeCrypto.randomUUID()}`;
    // syncedAt intentionally left unset, same as above: this row was never
    // disk-synced, so the empty fixture dir below must not disable it.
    await db.insert(workflow).values({
      key: workflowKey,
      title: "Sweep workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
    });
    const [run] = await db
      .insert(workflowRun)
      .values({
        workflowKey,
        trigger: "manual",
        status: "running",
        mode: "shadow",
        timeoutAt: sql`now() - interval '1 second'`,
      })
      .returning();
    expect(run).toBeDefined();

    const root = await emptyWorkflowsDir();
    const summary = await runMaintenanceTick({ db, workflowsDir: root, jobRetentionDays: 0 });

    expect(summary.runsTimedOut).toBeGreaterThanOrEqual(1);
    const [updated] = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, run!.id))
      .limit(1);
    expect(updated?.status).toBe("timed_out");
  });

  it("prunes finished jobs past retention", async () => {
    const idempotencyKey = `test-tick-prune-${NodeCrypto.randomUUID()}`;
    await db.insert(opsJob).values({
      type: "test.tick-prune",
      idempotencyKey,
      status: "succeeded",
      completedAt: sql`now() - interval '30 days'`,
    });

    const root = await emptyWorkflowsDir();
    await runMaintenanceTick({
      db,
      workflowsDir: root,
      jobRetentionDays: 1,
      sweepRuns: async () => ({ timedOut: 0 }),
    });

    const [row] = await db
      .select()
      .from(opsJob)
      .where(eq(opsJob.idempotencyKey, idempotencyKey))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it("does not prune when jobRetentionDays is 0", async () => {
    const idempotencyKey = `test-tick-no-prune-${NodeCrypto.randomUUID()}`;
    await db.insert(opsJob).values({
      type: "test.tick-no-prune",
      idempotencyKey,
      status: "succeeded",
      completedAt: sql`now() - interval '30 days'`,
    });

    const root = await emptyWorkflowsDir();
    await runMaintenanceTick({
      db,
      workflowsDir: root,
      jobRetentionDays: 0,
      sweepRuns: async () => ({ timedOut: 0 }),
    });

    const [row] = await db
      .select()
      .from(opsJob)
      .where(eq(opsJob.idempotencyKey, idempotencyKey))
      .limit(1);
    expect(row).toBeDefined();
  });
});
