import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// ops_job — the durable work queue. Adapted from Goodbird's battle-tested
// `durable_job` design (src/domains/jobs/durable-jobs.ts), simplified: no
// pipeline coupling, no cost accounting, no PostHog. See jobs/queue.ts for
// the leasing semantics this shape exists to support.
// ---------------------------------------------------------------------------

export const opsJobStatusEnum = pgEnum("ops_job_status", [
  "ready",
  "leased",
  "succeeded",
  "failed",
  "cancelled",
]);

export const opsJobRetryBackoffEnum = pgEnum("ops_job_retry_backoff", ["fixed", "exponential"]);

export const opsJob = pgTable(
  "ops_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: opsJobStatusEnum("status").default("ready").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    /** Dispatch band: lower first. 0 is human-blocking work. */
    priority: integer("priority").default(100).notNull(),
    retryBackoff: opsJobRetryBackoffEnum("retry_backoff").default("exponential").notNull(),
    retryDelayMs: integer("retry_delay_ms").default(30_000).notNull(),
    runAfter: timestamp("run_after", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    leaseUntil: timestamp("lease_until", { mode: "date", withTimezone: true }),
    leasedBy: text("leased_by"),
    leaseVersion: integer("lease_version").default(0).notNull(),
    progress: jsonb("progress").$type<Record<string, unknown>>(),
    cancelRequestedAt: timestamp("cancel_requested_at", { mode: "date", withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { mode: "date", withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("ops_job_ready_idx").on(t.status, t.runAfter),
    /** Serves the dispatch scan: order by priority within leasable status. */
    index("ops_job_dispatch_idx").on(t.status, t.priority, t.runAfter, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// workflow — the synced projection of a disk-defined workflow manifest, plus
// operational toggles. The manifest on disk is the source of truth for what
// a workflow does; this row exists so `mode` and `enabled` can be flipped
// without a deploy, and so a run can be traced back to the manifest that
// produced it.
// ---------------------------------------------------------------------------

export const workflowModeEnum = pgEnum("workflow_mode", ["fake", "shadow", "live"]);

export const workflow = pgTable("workflow", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  skillPath: text("skill_path").notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  manifestHash: text("manifest_hash").notNull(),
  mode: workflowModeEnum("mode").default("shadow").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  syncedAt: timestamp("synced_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// workflow_schedule — cron triggers for a workflow. A workflow may have
// several (e.g. a daily digest and a weekly rollup), hence the join table
// rather than a single cron column on `workflow`.
// ---------------------------------------------------------------------------

export const workflowSchedule = pgTable(
  "workflow_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowKey: text("workflow_key")
      .notNull()
      .references(() => workflow.key, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workflow_schedule_workflow_cron_uq").on(t.workflowKey, t.cron),
    /** Serves the scheduler tick's due-schedule scan. */
    index("workflow_schedule_due_idx").on(t.enabled, t.nextRunAt),
  ],
);

// ---------------------------------------------------------------------------
// workflow_run — one launch of a workflow, whether from a schedule, a manual
// trigger, or the API. Mirrors the run through its lifecycle: the agent
// session it launched, the durable job driving that launch, and the
// callback that eventually reports the result.
// ---------------------------------------------------------------------------

export const workflowRunTriggerEnum = pgEnum("workflow_run_trigger", ["schedule", "manual", "api"]);

export const workflowRunStatusEnum = pgEnum("workflow_run_status", [
  "pending",
  "launching",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

export const workflowRun = pgTable(
  "workflow_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowKey: text("workflow_key")
      .notNull()
      .references(() => workflow.key, { onDelete: "restrict" }),
    trigger: workflowRunTriggerEnum("trigger").notNull(),
    status: workflowRunStatusEnum("status").default("pending").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    /** The mode this run launched under; `workflow.mode` may change later without rewriting history. */
    mode: workflowModeEnum("mode").notNull(),
    phoenixThreadId: text("phoenix_thread_id"),
    /** Hash of the bearer token handed to the agent for its result callback; the token itself is never stored. */
    callbackTokenHash: text("callback_token_hash"),
    jobId: uuid("job_id").references(() => opsJob.id, { onDelete: "set null" }),
    timeoutAt: timestamp("timeout_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    index("workflow_run_workflow_created_idx").on(t.workflowKey, t.createdAt),
    index("workflow_run_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// audit_event — an append-only log of who did what, for every action that
// carries operational weight (schedule changes, mode flips, manual runs,
// callback deliveries). Never updated or deleted.
// ---------------------------------------------------------------------------

export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "attempted",
  "succeeded",
  "denied",
  "failed",
]);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    outcome: auditOutcomeEnum("outcome").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_event_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("audit_event_created_idx").on(t.createdAt),
  ],
);
