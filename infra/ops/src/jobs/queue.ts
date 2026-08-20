import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { Db, DbOrTx } from "../db/client.ts";
import { opsJob } from "../db/schema.ts";
import { isTerminalJobError, JobLeaseLostError, TerminalJobError } from "./errors.ts";
import type {
  ActiveJobLease,
  EnqueueJobInput,
  JobHandlerRegistry,
  OpsJobRetryBackoff,
  OpsJobRow,
} from "./types.ts";
import { createJobHandlerRegistry, defineJobHandler } from "./types.ts";

export const DEFAULT_JOB_LEASE_MS = 60_000;
/** Heartbeat cadence for long-running handlers: comfortably inside one lease window. */
export const DEFAULT_JOB_LEASE_HEARTBEAT_MS = 20_000;
export const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// Re-exported so callers have one import surface for the queue: errors and
// the handler registry are defined elsewhere only to keep this file's size
// down, not because callers should reach into those modules directly.
export {
  TerminalJobError,
  isTerminalJobError,
  JobLeaseLostError,
  defineJobHandler,
  createJobHandlerRegistry,
};

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export async function enqueueJob(input: EnqueueJobInput & { db: DbOrTx }): Promise<OpsJobRow> {
  const [inserted] = await input.db
    .insert(opsJob)
    .values({
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.retryBackoff !== undefined ? { retryBackoff: input.retryBackoff } : {}),
      ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
      ...(input.runAfter !== undefined ? { runAfter: input.runAfter } : {}),
    })
    .onConflictDoNothing({ target: opsJob.idempotencyKey })
    .returning();
  if (inserted) return inserted;

  // Lost the idempotency race: a job with this key already exists. Callers
  // enqueue without knowing whether they've already done so for this unit of
  // work, so the existing row is the answer, not an error.
  const [existing] = await input.db
    .select()
    .from(opsJob)
    .where(eq(opsJob.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new Error(
      `enqueueJob: idempotency key "${input.idempotencyKey}" conflicted but no row was found`,
    );
  }
  return existing;
}

// ---------------------------------------------------------------------------
// Leasing
//
// Compare against the database clock, not a JS Date parameter: raw Date
// parameters serialise as local wall-clock time against these UTC columns,
// and run_after defaults to the database's now(), which can sit ahead of the
// JS clock and make a freshly enqueued job look not yet due. Every due/lease
// comparison below runs as SQL against now(), never a JS Date.
// ---------------------------------------------------------------------------

const leasableJob = sql`(
  (${opsJob.status} = 'ready' and ${opsJob.runAfter} <= now()::timestamp)
  or (
    ${opsJob.status} = 'leased'
    and ${opsJob.leaseUntil} <= now()::timestamp
    and ${opsJob.cancelRequestedAt} is null
  )
)`;

export async function leaseNextJob(input: {
  db: Db;
  workerId: string;
  leaseMs?: number;
}): Promise<OpsJobRow | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_JOB_LEASE_MS));

  return input.db.transaction(async (tx) => {
    // No worker is coming back to acknowledge a cancellation whose lease has
    // already lapsed; sweep it here instead of leaving it stuck.
    await tx
      .update(opsJob)
      .set({
        status: "cancelled",
        cancelledAt: now,
        completedAt: now,
        leaseUntil: null,
        leasedBy: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(opsJob.status, "leased"),
          lte(opsJob.leaseUntil, now),
          isNotNull(opsJob.cancelRequestedAt),
        ),
      );

    const result = await tx.execute<{ id: string }>(sql`
      select ${opsJob.id} as id
      from ${opsJob}
      where ${leasableJob}
      order by ${opsJob.priority}, ${opsJob.runAfter}, ${opsJob.createdAt}
      for update skip locked
      limit 1
    `);
    const candidate = result.rows[0];
    if (!candidate) return null;

    const [leased] = await tx
      .update(opsJob)
      .set({
        status: "leased",
        leasedBy: input.workerId,
        leaseUntil,
        attempts: sql`${opsJob.attempts} + 1`,
        leaseVersion: sql`${opsJob.leaseVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(opsJob.id, candidate.id))
      .returning();
    return leased ?? null;
  });
}

/**
 * Leases one named job so a caller can drain work it just enqueued without
 * stealing unrelated queue entries. Returns null when the job is already
 * owned by a live lease.
 */
export async function leaseJobById(input: {
  db: Db;
  jobId: string;
  workerId: string;
  leaseMs?: number;
}): Promise<OpsJobRow | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_JOB_LEASE_MS));

  return input.db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      select ${opsJob.id} as id
      from ${opsJob}
      where ${opsJob.id} = ${input.jobId} and ${leasableJob}
      for update skip locked
      limit 1
    `);
    if (!result.rows[0]) return null;

    const [leased] = await tx
      .update(opsJob)
      .set({
        status: "leased",
        leasedBy: input.workerId,
        leaseUntil,
        attempts: sql`${opsJob.attempts} + 1`,
        leaseVersion: sql`${opsJob.leaseVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(opsJob.id, input.jobId))
      .returning();
    return leased ?? null;
  });
}

function currentLease(input: { jobId: string; workerId: string; leaseVersion: number }) {
  return and(
    eq(opsJob.id, input.jobId),
    eq(opsJob.status, "leased"),
    eq(opsJob.leasedBy, input.workerId),
    eq(opsJob.leaseVersion, input.leaseVersion),
  );
}

/** Extends only the live lease generation; expired, cancelled, and re-leased work cannot be revived. */
export async function renewJobLease(input: {
  db: Pick<Db, "update">;
  jobId: string;
  workerId: string;
  leaseVersion: number;
  leaseMs?: number;
}): Promise<OpsJobRow | null> {
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const [job] = await input.db
    .update(opsJob)
    .set({
      leaseUntil: sql`now()::timestamp + (${leaseMs} * interval '1 millisecond')`,
      updatedAt: sql`now()::timestamp`,
    })
    .where(
      and(
        currentLease(input),
        isNull(opsJob.cancelRequestedAt),
        gt(opsJob.leaseUntil, sql`now()::timestamp`),
      ),
    )
    .returning();
  return job ?? null;
}

/** Why a renewal matched no row. Read once, only on the terminal path. */
type JobLeaseLossCause = "expired" | "re_leased" | "cancel_requested" | "not_running" | "missing";

type JobLeaseRenewalReport =
  | Readonly<{ status: "renewed"; leaseUntil: Date | null }>
  /** The update matched no row: the lease is gone and cannot be revived. */
  | Readonly<{ status: "lost" }>
  /** The renewal call itself failed. The lease window may still be open. */
  | Readonly<{ status: "error"; error: unknown }>;

/**
 * Classifies one renewal instead of discarding it. A null return is
 * terminal — renewal requires `leaseUntil > now()`, so no later attempt can
 * succeed — while a throw is a blip the next beat may well recover from. The
 * two must not be merged into a single "renewal failed" bucket.
 */
async function reportJobLeaseRenewal(input: {
  db: Pick<Db, "update">;
  jobId: string;
  workerId: string;
  leaseVersion: number;
  leaseMs?: number;
}): Promise<JobLeaseRenewalReport> {
  try {
    const job = await renewJobLease(input);
    return job
      ? Object.freeze({ status: "renewed" as const, leaseUntil: job.leaseUntil })
      : Object.freeze({ status: "lost" as const });
  } catch (error) {
    return Object.freeze({ status: "error" as const, error });
  }
}

/** Reads why the lease row stopped matching, for the log line that reports it. */
async function diagnoseJobLeaseLoss(input: {
  db: Pick<Db, "select">;
  jobId: string;
  workerId: string;
  leaseVersion: number;
}): Promise<JobLeaseLossCause> {
  const [job] = await input.db
    .select({
      status: opsJob.status,
      leasedBy: opsJob.leasedBy,
      leaseVersion: opsJob.leaseVersion,
      cancelRequestedAt: opsJob.cancelRequestedAt,
      expired: sql<boolean>`${opsJob.leaseUntil} is null or ${opsJob.leaseUntil} <= now()::timestamp`,
    })
    .from(opsJob)
    .where(eq(opsJob.id, input.jobId))
    .limit(1);
  if (!job) return "missing";
  if (job.cancelRequestedAt) return "cancel_requested";
  if (job.leaseVersion !== input.leaseVersion || job.leasedBy !== input.workerId)
    return "re_leased";
  if (job.expired) return "expired";
  return "not_running";
}

type JobLeaseHeartbeatEvent = Readonly<{
  event: "job.lease.renewal";
  jobId: string;
  workerId: string;
  leaseVersion: number;
  status: JobLeaseRenewalReport["status"];
  msSinceRenewal: number;
  consecutiveErrors: number;
  lostBecause?: JobLeaseLossCause;
  error?: string;
  aborted?: "lost" | "expired";
}>;

type JobLeaseObserver = (event: JobLeaseHeartbeatEvent) => void;

function logJobLeaseEvent(event: JobLeaseHeartbeatEvent): void {
  const line = JSON.stringify(event);
  if (event.status === "renewed") console.log(line);
  else console.warn(line);
}

/**
 * Runs `run` while a background heartbeat keeps the job's lease live, so
 * work that outlasts one lease window is never re-leased and run a second
 * time concurrently by another worker (a real risk after a rolling deploy).
 * The heartbeat renews only the active lease generation, and the timer is
 * always cleared once the work settles.
 *
 * Every renewal outcome is reported, and a lease that is provably gone
 * aborts the run instead of letting it keep working toward a completion
 * that can no longer be published. The two failure shapes are held apart on
 * purpose:
 *
 * - a **null return** means the update matched no row. Renewal requires
 *   `leaseUntil > now()`, so nothing later can revive it — abort immediately.
 * - a **throw** means the renewal call failed, which says nothing about the
 *   lease. The window is still open until `leaseMs` has elapsed since the
 *   last SUCCESSFUL renewal, so keep beating; at a 20s cadence inside a 60s
 *   window two consecutive failures are survivable. Only once that whole
 *   window has lapsed without a success is the lease certainly gone.
 */
export async function withJobLeaseHeartbeat<T>(input: {
  db: Pick<Db, "update" | "select">;
  job: Pick<OpsJobRow, "id" | "leaseVersion">;
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  observer?: JobLeaseObserver;
  run: (lease: ActiveJobLease) => Promise<T>;
}): Promise<T> {
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const heartbeatMs = input.heartbeatMs ?? DEFAULT_JOB_LEASE_HEARTBEAT_MS;
  const observe = input.observer ?? logJobLeaseEvent;
  const leaseLost = new AbortController();
  const lease: ActiveJobLease = {
    jobId: input.job.id,
    workerId: input.workerId,
    leaseVersion: input.job.leaseVersion,
    leaseMs,
    leaseLostSignal: leaseLost.signal,
  };

  // Elapsed on the JS clock only. The lease window itself is a database
  // interval; comparing a database timestamp against Date.now() would mix
  // two clocks, so this measures the gap since our own last success instead.
  let renewedAt = Date.now();
  let consecutiveErrors = 0;
  let stopped = false;
  let lost: JobLeaseLostError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = async (
    reason: "lost" | "expired",
    base: Omit<JobLeaseHeartbeatEvent, "aborted" | "lostBecause">,
  ) => {
    const lostBecause =
      reason === "lost"
        ? await diagnoseJobLeaseLoss({
            db: input.db,
            jobId: lease.jobId,
            workerId: lease.workerId,
            leaseVersion: lease.leaseVersion,
          }).catch(() => undefined)
        : undefined;
    lost = new JobLeaseLostError(reason, lease.jobId);
    observe(
      Object.freeze({
        ...base,
        ...(lostBecause !== undefined ? { lostBecause } : {}),
        aborted: reason,
      }),
    );
    leaseLost.abort(lost);
  };

  const beat = async () => {
    if (stopped) return;
    const report = await reportJobLeaseRenewal({
      db: input.db,
      jobId: lease.jobId,
      workerId: lease.workerId,
      leaseVersion: lease.leaseVersion,
      leaseMs,
    });
    if (stopped) return;

    if (report.status === "renewed") {
      renewedAt = Date.now();
      consecutiveErrors = 0;
      observe(
        Object.freeze({
          event: "job.lease.renewal" as const,
          jobId: lease.jobId,
          workerId: lease.workerId,
          leaseVersion: lease.leaseVersion,
          status: "renewed" as const,
          msSinceRenewal: 0,
          consecutiveErrors: 0,
        }),
      );
    } else if (report.status === "lost") {
      await abort("lost", {
        event: "job.lease.renewal",
        jobId: lease.jobId,
        workerId: lease.workerId,
        leaseVersion: lease.leaseVersion,
        status: "lost",
        msSinceRenewal: Date.now() - renewedAt,
        consecutiveErrors,
      });
      return;
    } else {
      consecutiveErrors += 1;
      const msSinceRenewal = Date.now() - renewedAt;
      const base = {
        event: "job.lease.renewal" as const,
        jobId: lease.jobId,
        workerId: lease.workerId,
        leaseVersion: lease.leaseVersion,
        status: "error" as const,
        msSinceRenewal,
        consecutiveErrors,
        error:
          report.error instanceof Error ? report.error.message : "Unknown lease renewal failure",
      };
      // The window is only certainly gone once a full lease has elapsed with
      // nothing successfully renewed inside it.
      if (msSinceRenewal >= leaseMs) {
        await abort("expired", base);
        return;
      }
      observe(Object.freeze(base));
    }
    if (!stopped) timer = setTimeout(() => void beat(), heartbeatMs);
  };

  // A self-scheduling timer rather than setInterval: an interval whose
  // renewals run longer than the cadence stacks them up, which is itself a
  // way to saturate the pool the renewals need.
  timer = setTimeout(() => void beat(), heartbeatMs);
  try {
    const result = await input.run(lease);
    if (lost) throw lost;
    return result;
  } catch (error) {
    // A handler that unwound because we aborted it reports the lease loss,
    // not whatever the abort happened to surface as.
    if (lost && !(error instanceof JobLeaseLostError)) throw lost;
    throw error;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Completion, progress, cancellation
// ---------------------------------------------------------------------------

export async function completeJob(input: {
  db: Db;
  jobId: string;
  workerId: string;
  leaseVersion: number;
  result?: Record<string, unknown>;
}): Promise<OpsJobRow | null> {
  const now = new Date();
  const [job] = await input.db
    .update(opsJob)
    .set({
      status: "succeeded",
      result: input.result ?? null,
      completedAt: now,
      leaseUntil: null,
      leasedBy: null,
      updatedAt: now,
    })
    .where(and(currentLease(input), isNull(opsJob.cancelRequestedAt)))
    .returning();
  return job ?? null;
}

export async function updateJobProgress(input: {
  db: Db;
  jobId: string;
  workerId: string;
  leaseVersion: number;
  progress: Record<string, unknown>;
}): Promise<OpsJobRow | null> {
  const [job] = await input.db
    .update(opsJob)
    .set({ progress: input.progress, updatedAt: new Date() })
    .where(currentLease(input))
    .returning();
  return job ?? null;
}

export async function requestJobCancellation(input: {
  db: DbOrTx;
  jobId: string;
}): Promise<OpsJobRow | null> {
  const now = new Date();
  const nowLiteral = now.toISOString();
  const [job] = await input.db
    .update(opsJob)
    .set({
      status: sql`case when ${opsJob.status} = 'ready' then 'cancelled' else ${opsJob.status} end`,
      cancelRequestedAt: now,
      cancelledAt: sql`case when ${opsJob.status} = 'ready' then ${nowLiteral}::timestamp else ${opsJob.cancelledAt} end`,
      completedAt: sql`case when ${opsJob.status} = 'ready' then ${nowLiteral}::timestamp else ${opsJob.completedAt} end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(opsJob.id, input.jobId),
        inArray(opsJob.status, ["ready", "leased"]),
        isNull(opsJob.cancelRequestedAt),
      ),
    )
    .returning();
  return job ?? null;
}

export async function checkJobCancellation(input: {
  db: Db;
  jobId: string;
  workerId: string;
  leaseVersion: number;
}): Promise<"active" | "cancel_requested" | "lost_lease"> {
  const [job] = await input.db
    .select({ cancelRequestedAt: opsJob.cancelRequestedAt })
    .from(opsJob)
    .where(currentLease(input))
    .limit(1);
  if (!job) return "lost_lease";
  return job.cancelRequestedAt ? "cancel_requested" : "active";
}

export async function acknowledgeJobCancellation(input: {
  db: Db;
  jobId: string;
  workerId: string;
  leaseVersion: number;
  /** Handler error observed before the cancellation was acknowledged; preserved for diagnostics. */
  error?: unknown;
}): Promise<OpsJobRow | null> {
  const now = new Date();
  const [job] = await input.db
    .update(opsJob)
    .set({
      status: "cancelled",
      cancelledAt: now,
      completedAt: now,
      leaseUntil: null,
      leasedBy: null,
      updatedAt: now,
      ...(input.error === undefined
        ? {}
        : { lastError: input.error instanceof Error ? input.error.message : "Unknown job error" }),
    })
    .where(and(currentLease(input), isNotNull(opsJob.cancelRequestedAt)))
    .returning();
  return job ?? null;
}

// ---------------------------------------------------------------------------
// Retry policy — pure and unit-testable in isolation from the database.
// ---------------------------------------------------------------------------

/**
 * Retry pacing precedence: an explicit pacing window (a provider reporting
 * when it frees a slot) beats the job's declared policy; the declared policy
 * beats the flat default. Exponential backoff doubles per attempt already
 * spent, so the first retry after the first failed attempt is not delayed.
 */
export function resolveRetryDelayMs(input: {
  attempts: number;
  retryBackoff: OpsJobRetryBackoff;
  retryDelayMs?: number;
  retryAfterMs?: number;
}): number {
  if (input.retryAfterMs !== undefined) return input.retryAfterMs;
  const declared = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  return input.retryBackoff === "exponential"
    ? declared * 2 ** Math.max(0, input.attempts - 1)
    : declared;
}

/**
 * Whether this attempt is the job's last. `attemptNeutral` failures (a
 * self-imposed pacing deferral, not a real failure) never exhaust the
 * budget, so sustained rate pressure can't dead-letter otherwise-healthy
 * work; an explicit `terminal` failure always does, regardless of budget.
 */
export function isJobRetryExhausted(input: {
  attempts: number;
  maxAttempts: number;
  attemptNeutral?: boolean;
  terminal?: boolean;
}): boolean {
  if (input.terminal) return true;
  if (input.attemptNeutral) return false;
  return input.attempts >= input.maxAttempts;
}

export async function failJob(input: {
  db: Db;
  job: OpsJobRow;
  workerId: string;
  error: unknown;
  /** A self-imposed pacing deferral; see `isJobRetryExhausted`. */
  retryAfterMs?: number;
  attemptNeutral?: boolean;
  /** A contract violation that cannot recover by executing the same handler again. */
  terminal?: boolean;
}): Promise<OpsJobRow | null> {
  const terminal = isJobRetryExhausted({
    attempts: input.job.attempts,
    maxAttempts: input.job.maxAttempts,
    ...(input.attemptNeutral !== undefined ? { attemptNeutral: input.attemptNeutral } : {}),
    ...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
  });
  const now = new Date();
  const retryAfterMs = resolveRetryDelayMs({
    attempts: input.job.attempts,
    retryBackoff: input.job.retryBackoff,
    retryDelayMs: input.job.retryDelayMs,
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
  const retryAt =
    retryAfterMs <= 0 ? sql`now()::timestamp` : new Date(now.getTime() + retryAfterMs);
  const lastError = input.error instanceof Error ? input.error.message : "Unknown job error";

  const [job] = await input.db
    .update(opsJob)
    .set({
      status: terminal ? "failed" : "ready",
      runAfter: terminal ? input.job.runAfter : retryAt,
      leaseUntil: null,
      leasedBy: null,
      ...(input.attemptNeutral ? { attempts: sql`greatest(${opsJob.attempts} - 1, 0)` } : {}),
      lastError,
      completedAt: terminal ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        currentLease({
          jobId: input.job.id,
          workerId: input.workerId,
          leaseVersion: input.job.leaseVersion,
        }),
        isNull(opsJob.cancelRequestedAt),
      ),
    )
    .returning();
  return job ?? null;
}

// ---------------------------------------------------------------------------
// Drain loop
// ---------------------------------------------------------------------------

type JobQueueLogEvent =
  | Readonly<{
      event: "job.leased";
      jobId: string;
      jobType: string;
      workerId: string;
      attempts: number;
    }>
  | Readonly<{ event: "job.completed"; jobId: string; jobType: string; workerId: string }>
  | Readonly<{
      event: "job.failed";
      jobId: string;
      jobType: string;
      workerId: string;
      terminal: boolean;
    }>
  | Readonly<{ event: "job.cancelled"; jobId: string; jobType: string; workerId: string }>
  /** Neither complete, fail, nor cancel could write a terminal state: another worker holds the lease now. */
  | Readonly<{ event: "job.lease.lost"; jobId: string; jobType: string; workerId: string }>;

function logJobQueueEvent(event: JobQueueLogEvent): void {
  console.log(JSON.stringify(event));
}

export type RunReadyJobsOptions = Readonly<{
  signal?: AbortSignal;
  leaseMs?: number;
  pollIntervalMs?: number;
}>;

/** Resolves `ms` early if `signal` aborts while waiting, so shutdown isn't delayed by a stale poll timer. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function extractPacingRetryAfterMs(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "retryAfterMs" in error &&
    typeof (error as { retryAfterMs: unknown }).retryAfterMs === "number"
    ? (error as { retryAfterMs: number }).retryAfterMs
    : undefined;
}

async function runLeasedJob(input: {
  db: Db;
  job: OpsJobRow;
  registry: JobHandlerRegistry;
  workerId: string;
  leaseMs: number;
}): Promise<void> {
  const { db, job, registry, workerId, leaseMs } = input;
  logJobQueueEvent({
    event: "job.leased",
    jobId: job.id,
    jobType: job.type,
    workerId,
    attempts: job.attempts,
  });

  const definition = registry.get(job.type);
  if (!definition) {
    await failJob({
      db,
      job,
      workerId,
      error: new TerminalJobError(`No handler registered for job type "${job.type}"`),
      terminal: true,
    });
    logJobQueueEvent({
      event: "job.failed",
      jobId: job.id,
      jobType: job.type,
      workerId,
      terminal: true,
    });
    return;
  }

  try {
    const result = await withJobLeaseHeartbeat({
      db,
      job,
      workerId,
      leaseMs,
      run: (lease) => definition.handle(job, lease),
    });
    const completed = await completeJob({
      db,
      jobId: job.id,
      workerId,
      leaseVersion: job.leaseVersion,
      ...(result !== undefined ? { result } : {}),
    });
    if (completed) {
      logJobQueueEvent({ event: "job.completed", jobId: job.id, jobType: job.type, workerId });
      return;
    }
    const cancelled = await acknowledgeJobCancellation({
      db,
      jobId: job.id,
      workerId,
      leaseVersion: job.leaseVersion,
    });
    if (cancelled) {
      logJobQueueEvent({ event: "job.cancelled", jobId: job.id, jobType: job.type, workerId });
      return;
    }
    logJobQueueEvent({ event: "job.lease.lost", jobId: job.id, jobType: job.type, workerId });
  } catch (error) {
    const cancelled = await acknowledgeJobCancellation({
      db,
      jobId: job.id,
      workerId,
      leaseVersion: job.leaseVersion,
      error,
    });
    if (cancelled) {
      logJobQueueEvent({ event: "job.cancelled", jobId: job.id, jobType: job.type, workerId });
      return;
    }
    const pacing = extractPacingRetryAfterMs(error);
    const failed = await failJob({
      db,
      job,
      workerId,
      error,
      ...(pacing !== undefined ? { retryAfterMs: pacing, attemptNeutral: true } : {}),
      terminal: isTerminalJobError(error),
    });
    if (failed) {
      logJobQueueEvent({
        event: "job.failed",
        jobId: job.id,
        jobType: job.type,
        workerId,
        terminal: failed.status === "failed",
      });
      return;
    }
    logJobQueueEvent({ event: "job.lease.lost", jobId: job.id, jobType: job.type, workerId });
  }
}

/** Leases and runs ready jobs until `signal` aborts. One job at a time, by design — this is a foundation, not a pool. */
export async function runReadyJobs(
  db: Db,
  registry: JobHandlerRegistry,
  workerId: string,
  options: RunReadyJobsOptions = {},
): Promise<void> {
  const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const signal = options.signal;

  while (!signal?.aborted) {
    const job = await leaseNextJob({ db, workerId, leaseMs });
    if (!job) {
      await sleep(pollIntervalMs, signal);
      continue;
    }
    await runLeasedJob({ db, job, registry, workerId, leaseMs });
  }
}
