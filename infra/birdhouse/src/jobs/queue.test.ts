import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { opsJob } from "../db/schema.ts";
import { isTerminalJobError, TerminalJobError } from "./errors.ts";
import {
  acknowledgeJobCancellation,
  completeJob,
  createJobHandlerRegistry,
  DEFAULT_RETRY_DELAY_MS,
  defineJobHandler,
  enqueueJob,
  failJob,
  isJobRetryExhausted,
  leaseJobById,
  leaseNextJob,
  pruneTerminalJobs,
  requestJobCancellation,
  resolveRetryDelayMs,
  runReadyJobs,
} from "./queue.ts";

describe("resolveRetryDelayMs", () => {
  it("prefers an explicit pacing window over any declared policy", () => {
    expect(
      resolveRetryDelayMs({
        attempts: 3,
        retryBackoff: "exponential",
        retryDelayMs: 1_000,
        retryAfterMs: 500,
      }),
    ).toBe(500);
  });

  it("doubles per attempt already spent under exponential backoff", () => {
    expect(
      resolveRetryDelayMs({ attempts: 1, retryBackoff: "exponential", retryDelayMs: 1_000 }),
    ).toBe(1_000);
    expect(
      resolveRetryDelayMs({ attempts: 2, retryBackoff: "exponential", retryDelayMs: 1_000 }),
    ).toBe(2_000);
    expect(
      resolveRetryDelayMs({ attempts: 3, retryBackoff: "exponential", retryDelayMs: 1_000 }),
    ).toBe(4_000);
    expect(
      resolveRetryDelayMs({ attempts: 4, retryBackoff: "exponential", retryDelayMs: 1_000 }),
    ).toBe(8_000);
  });

  it("never doubles below the first attempt", () => {
    expect(
      resolveRetryDelayMs({ attempts: 0, retryBackoff: "exponential", retryDelayMs: 1_000 }),
    ).toBe(1_000);
  });

  it("holds the declared delay flat under fixed backoff", () => {
    expect(resolveRetryDelayMs({ attempts: 5, retryBackoff: "fixed", retryDelayMs: 2_000 })).toBe(
      2_000,
    );
  });

  it("falls back to the flat default when no delay is declared", () => {
    expect(resolveRetryDelayMs({ attempts: 1, retryBackoff: "fixed" })).toBe(
      DEFAULT_RETRY_DELAY_MS,
    );
    expect(resolveRetryDelayMs({ attempts: 1, retryBackoff: "exponential" })).toBe(
      DEFAULT_RETRY_DELAY_MS,
    );
  });
});

describe("isJobRetryExhausted", () => {
  it("is not exhausted while attempts remain under the budget", () => {
    expect(isJobRetryExhausted({ attempts: 2, maxAttempts: 5 })).toBe(false);
  });

  it("is exhausted once attempts reach the budget", () => {
    expect(isJobRetryExhausted({ attempts: 5, maxAttempts: 5 })).toBe(true);
    expect(isJobRetryExhausted({ attempts: 6, maxAttempts: 5 })).toBe(true);
  });

  it("an explicit terminal failure exhausts regardless of budget", () => {
    expect(isJobRetryExhausted({ attempts: 1, maxAttempts: 5, terminal: true })).toBe(true);
  });

  it("an attempt-neutral failure never exhausts, even past budget", () => {
    expect(isJobRetryExhausted({ attempts: 99, maxAttempts: 5, attemptNeutral: true })).toBe(false);
  });

  it("terminal wins over attempt-neutral: a pacing signal cannot mask a contract violation", () => {
    expect(
      isJobRetryExhausted({ attempts: 1, maxAttempts: 5, attemptNeutral: true, terminal: true }),
    ).toBe(true);
  });
});

describe("terminal error contract", () => {
  it("classifies a TerminalJobError as terminal", () => {
    expect(isTerminalJobError(new TerminalJobError("bad payload"))).toBe(true);
  });

  it("does not classify an ordinary Error as terminal", () => {
    expect(isTerminalJobError(new Error("transient"))).toBe(false);
  });

  it("does not classify non-Error values as terminal", () => {
    expect(isTerminalJobError("bad payload")).toBe(false);
    expect(isTerminalJobError(undefined)).toBe(false);
  });
});

// Exercises the on-conflict path against a real Postgres, since
// onConflictDoNothing + a fallback select is a database-level race, not
// something a mock can represent faithfully.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("enqueueJob", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });

  afterAll(async () => {
    await pool.end();
  });

  it("returns the existing row instead of erroring on a repeat idempotency key", async () => {
    const idempotencyKey = `test:${randomUUID()}`;
    const first = await enqueueJob({ db, type: "test.noop", payload: { n: 1 }, idempotencyKey });
    const second = await enqueueJob({ db, type: "test.noop", payload: { n: 2 }, idempotencyKey });

    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ n: 1 });
  });
});

// The full lease lifecycle — lease, complete/fail/cancel — is a set of
// concurrent SQL statements racing against real lease-ownership columns;
// worth exercising against Postgres rather than trusting the query builder
// produced what the raw `for update skip locked` SQL intends.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("job lifecycle", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });
  const workerId = "test-worker";

  afterAll(async () => {
    await pool.end();
  });

  it("leases a ready job and completes it", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.lifecycle",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
    });

    const leased = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(leased?.id).toBe(enqueued.id);
    expect(leased?.status).toBe("leased");
    expect(leased?.attempts).toBe(1);

    const completed = await completeJob({
      db,
      jobId: enqueued.id,
      workerId,
      leaseVersion: leased!.leaseVersion,
      result: { ok: true },
    });
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result).toEqual({ ok: true });
  });

  it("requeues a failed job under its retry budget, and exhausts it once attempts run out", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.lifecycle",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
      maxAttempts: 2,
      retryBackoff: "fixed",
      retryDelayMs: 0,
    });

    const firstLease = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(firstLease?.attempts).toBe(1);
    const failedOnce = await failJob({
      db,
      job: firstLease!,
      workerId,
      error: new Error("transient"),
    });
    expect(failedOnce?.status).toBe("ready");
    expect(failedOnce?.lastError).toBe("transient");

    const secondLease = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(secondLease?.id).toBe(enqueued.id);
    expect(secondLease?.attempts).toBe(2);
    const failedTwice = await failJob({
      db,
      job: secondLease!,
      workerId,
      error: new Error("still failing"),
    });
    expect(failedTwice?.status).toBe("failed");
    expect(failedTwice?.completedAt).not.toBeNull();
  });

  it("fails a terminal error on the first attempt regardless of remaining budget", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.lifecycle",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
      maxAttempts: 5,
    });
    const leased = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(leased?.id).toBe(enqueued.id);

    const failed = await failJob({
      db,
      job: leased!,
      workerId,
      error: new TerminalJobError("bad payload"),
      terminal: true,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
  });

  it("acknowledges a cooperative cancellation raised mid-lease", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.lifecycle",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
    });
    const leased = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(leased?.id).toBe(enqueued.id);

    const requested = await requestJobCancellation({ db, jobId: enqueued.id });
    expect(requested?.status).toBe("leased");
    expect(requested?.cancelRequestedAt).not.toBeNull();

    const acknowledged = await acknowledgeJobCancellation({
      db,
      jobId: enqueued.id,
      workerId,
      leaseVersion: leased!.leaseVersion,
    });
    expect(acknowledged?.status).toBe("cancelled");
  });

  it("cancels a ready job immediately, with no lease to acknowledge", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.lifecycle",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
      runAfter: new Date(Date.now() + 3_600_000),
    });

    const requested = await requestJobCancellation({ db, jobId: enqueued.id });
    expect(requested?.status).toBe("cancelled");
    expect(requested?.completedAt).not.toBeNull();
  });
});

// A worker that dies mid-handler never reports the attempt it spent, so the
// only enforcement of the retry budget (failJob) never runs for it. These
// exercise the reclaim path directly: expiring a lease by hand is exactly
// what a crashed worker leaves behind.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("expired lease reclaim", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });
  const workerId = "test-worker-reclaim";

  afterAll(async () => {
    await pool.end();
  });

  /** Backdates the lease so the row looks like a worker that died holding it. */
  async function expireLease(jobId: string): Promise<void> {
    await db
      .update(opsJob)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(opsJob.id, jobId));
  }

  async function readJob(jobId: string) {
    const [row] = await db.select().from(opsJob).where(eq(opsJob.id, jobId)).limit(1);
    return row;
  }

  it("re-leases a crashed job while it still has attempts left", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.reclaim",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
      maxAttempts: 3,
    });
    const first = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(first?.attempts).toBe(1);

    await expireLease(enqueued.id);
    const second = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(second?.id).toBe(enqueued.id);
    expect(second?.attempts).toBe(2);
  });

  it("dead-letters a job that burns its last attempt without reporting back", async () => {
    const enqueued = await enqueueJob({
      db,
      type: "test.reclaim",
      payload: {},
      idempotencyKey: `test:${randomUUID()}`,
      maxAttempts: 1,
    });
    const leased = await leaseJobById({ db, jobId: enqueued.id, workerId });
    expect(leased?.attempts).toBe(1);

    await expireLease(enqueued.id);
    // Not a leasable candidate any more, so the drain loop can't pick it up
    // and crash on it again.
    expect(await leaseJobById({ db, jobId: enqueued.id, workerId })).toBeNull();

    // leaseNextJob's sweep is what actually retires it.
    await leaseNextJob({ db, workerId });
    const reaped = await readJob(enqueued.id);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.completedAt).not.toBeNull();
    expect(reaped?.leasedBy).toBeNull();
  });
});

// The drain loop settling is how the worker process ends, so a queue-level
// throw must not escape it.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("runReadyJobs resilience", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps polling after the queue itself throws, and still drains once it recovers", async () => {
    const idempotencyKey = `test:${randomUUID()}`;
    const enqueued = await enqueueJob({ db, type: "test.resilience", payload: {}, idempotencyKey });

    let failuresLeft = 2;
    const brokenThenHealthy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction" && failuresLeft > 0) {
          failuresLeft -= 1;
          return () => Promise.reject(new Error("connection terminated unexpectedly"));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const controller = new AbortController();
    let resolveHandled: () => void;
    const handled = new Promise<void>((r) => {
      resolveHandled = r;
    });
    const registry = createJobHandlerRegistry([
      defineJobHandler({
        type: "test.resilience",
        handle: async () => {
          resolveHandled();
          return { ok: true };
        },
      }),
    ]);
    const draining = runReadyJobs(brokenThenHealthy, registry, "test-worker-resilience", {
      signal: controller.signal,
      pollIntervalMs: 1,
      maxPollIntervalMs: 5,
    });

    // Abort once the handler has run, then await the loop itself: it only
    // settles after the in-flight job has been marked complete.
    await handled;
    controller.abort();
    await draining;
    expect(failuresLeft).toBe(0);

    const [row] = await db.select().from(opsJob).where(eq(opsJob.id, enqueued.id)).limit(1);
    expect(row?.status).toBe("succeeded");
  });
});

// Nothing else ever deletes from ops_job, and the watch chain mints a row per
// run per poll — so without pruning the table (and both its indexes) grows
// without bound.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("pruneTerminalJobs", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });

  afterAll(async () => {
    await pool.end();
  });

  it("deletes finished jobs past the cutoff and keeps everything else", async () => {
    const staleKey = `test:${randomUUID()}`;
    const recentKey = `test:${randomUUID()}`;
    const openKey = `test:${randomUUID()}`;
    const stale = await enqueueJob({
      db,
      type: "test.prune",
      payload: {},
      idempotencyKey: staleKey,
    });
    const recent = await enqueueJob({
      db,
      type: "test.prune",
      payload: {},
      idempotencyKey: recentKey,
    });
    // Still ready, and backdated: age alone must not retire live work.
    const open = await enqueueJob({ db, type: "test.prune", payload: {}, idempotencyKey: openKey });

    await db
      .update(opsJob)
      .set({ status: "succeeded", completedAt: sql`now() - interval '30 days'` })
      .where(eq(opsJob.id, stale.id));
    await db
      .update(opsJob)
      .set({ status: "succeeded", completedAt: sql`now()` })
      .where(eq(opsJob.id, recent.id));
    await db
      .update(opsJob)
      .set({ createdAt: sql`now() - interval '30 days'` })
      .where(eq(opsJob.id, open.id));

    await pruneTerminalJobs({ db, retentionDays: 14 });

    const survivors = await db
      .select({ id: opsJob.id })
      .from(opsJob)
      .where(inArray(opsJob.id, [stale.id, recent.id, open.id]));
    const ids = survivors.map((row) => row.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toContain(recent.id);
    expect(ids).toContain(open.id);
  });
});
