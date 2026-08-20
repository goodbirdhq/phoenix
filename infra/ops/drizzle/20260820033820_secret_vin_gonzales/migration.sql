CREATE TYPE "audit_outcome" AS ENUM('attempted', 'succeeded', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "ops_job_retry_backoff" AS ENUM('fixed', 'exponential');--> statement-breakpoint
CREATE TYPE "ops_job_status" AS ENUM('ready', 'leased', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "workflow_mode" AS ENUM('fake', 'shadow', 'live');--> statement-breakpoint
CREATE TYPE "workflow_run_status" AS ENUM('pending', 'launching', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "workflow_run_trigger" AS ENUM('schedule', 'manual', 'api');--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" text NOT NULL,
	"status" "ops_job_status" DEFAULT 'ready'::"ops_job_status" NOT NULL,
	"idempotency_key" text NOT NULL UNIQUE,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"retry_backoff" "ops_job_retry_backoff" DEFAULT 'exponential'::"ops_job_retry_backoff" NOT NULL,
	"retry_delay_ms" integer DEFAULT 30000 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"leased_by" text,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"progress" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow" (
	"key" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text,
	"skill_path" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"mode" "workflow_mode" DEFAULT 'shadow'::"workflow_mode" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workflow_key" text NOT NULL,
	"trigger" "workflow_run_trigger" NOT NULL,
	"status" "workflow_run_status" DEFAULT 'pending'::"workflow_run_status" NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"error" text,
	"mode" "workflow_mode" NOT NULL,
	"phoenix_thread_id" text,
	"callback_token_hash" text,
	"job_id" uuid,
	"timeout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workflow_key" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_event_target_idx" ON "audit_event" ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_created_idx" ON "audit_event" ("created_at");--> statement-breakpoint
CREATE INDEX "ops_job_ready_idx" ON "ops_job" ("status","run_after");--> statement-breakpoint
CREATE INDEX "ops_job_dispatch_idx" ON "ops_job" ("status","priority","run_after","created_at");--> statement-breakpoint
CREATE INDEX "workflow_run_workflow_created_idx" ON "workflow_run" ("workflow_key","created_at");--> statement-breakpoint
CREATE INDEX "workflow_run_status_idx" ON "workflow_run" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_schedule_workflow_cron_uq" ON "workflow_schedule" ("workflow_key","cron");--> statement-breakpoint
CREATE INDEX "workflow_schedule_due_idx" ON "workflow_schedule" ("enabled","next_run_at");--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflow_key_workflow_key_fkey" FOREIGN KEY ("workflow_key") REFERENCES "workflow"("key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_job_id_ops_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ops_job"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workflow_schedule" ADD CONSTRAINT "workflow_schedule_workflow_key_workflow_key_fkey" FOREIGN KEY ("workflow_key") REFERENCES "workflow"("key") ON DELETE CASCADE;