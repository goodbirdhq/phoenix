import { Cron } from "croner";
import { z } from "zod";

export const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const PHOENIX_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

function cronScheduleSchema(defaultTimezone: string) {
  return z
    .object({
      cron: z.string().min(1, "cron is required"),
      timezone: z.string().min(1).default(defaultTimezone),
      enabled: z.boolean().default(true),
    })
    .superRefine((schedule, ctx) => {
      try {
        // Constructing without a callback function only parses and
        // validates the pattern — croner schedules a real timer solely
        // inside `.schedule()`, which its constructor calls only when a
        // callback is supplied (see `src/lib/cron.ts`).
        new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: `invalid cron expression "${schedule.cron}": ${error instanceof Error ? error.message : String(error)}`,
          path: ["cron"],
        });
      }
    });
}

function workflowManifestSchemaFor(defaultTimezone: string) {
  return z.object({
    key: z.string().regex(WORKFLOW_KEY_PATTERN, "key must match ^[a-z0-9][a-z0-9-]*$"),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    /** Path to the skill file, relative to the workflow's own directory. */
    skill: z.string().min(1),
    schedules: z.array(cronScheduleSchema(defaultTimezone)).default([]),
    // An opaque JSON Schema document: validated by whatever consumes it
    // downstream (the manual-run input parser), not by this schema.
    input_schema: z.record(z.string(), z.unknown()).optional(),
    timeout_ms: z.number().int().positive().optional(),
    phoenix: z
      .object({
        provider_instance_id: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        runtime_mode: z.enum(PHOENIX_RUNTIME_MODES).optional(),
      })
      .optional(),
  });
}

export type WorkflowScheduleManifest = z.infer<ReturnType<typeof cronScheduleSchema>>;
export type WorkflowManifest = z.infer<ReturnType<typeof workflowManifestSchemaFor>>;

/**
 * Builds the manifest schema with `defaultTimezone` baked into each
 * schedule's `timezone` default. A factory rather than a module-level
 * constant: the default (`OPS_TIMEZONE`) is only known once the caller is
 * ready to supply it, and this module deliberately never imports
 * `config.ts` itself, so it — and everything built on it — can be unit
 * tested without a database configured (`config.ts` validates
 * `OPS_DATABASE_URL` eagerly at import time).
 */
export function createWorkflowManifestSchema(defaultTimezone: string) {
  return workflowManifestSchemaFor(defaultTimezone);
}
