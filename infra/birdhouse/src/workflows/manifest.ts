import { z } from "zod";

export const WORKFLOW_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const PHOENIX_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

const workflowManifestSchema = z.object({
  key: z.string().regex(WORKFLOW_KEY_PATTERN, "key must match ^[a-z0-9][a-z0-9-]*$"),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  /** Path to the skill file, relative to the workflow's own directory. */
  skill: z.string().min(1),
  // An opaque JSON Schema document: advisory documentation of the shape a
  // workflow's `input` should take. Nothing parses or enforces it — both
  // `ManualRunBodySchema` and `ClaimBodySchema` (src/http/server.ts) type
  // `input` as `z.unknown()`, and no reader looks this field back up.
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

export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

/**
 * Builds the manifest schema. A factory rather than a bare export for
 * symmetry with callers that resolve it once and reuse it — this module
 * deliberately never imports `config.ts` itself, so it — and everything
 * built on it — can be unit tested without a database configured (`config.ts`
 * validates `BIRDHOUSE_DATABASE_URL` eagerly at import time).
 */
export function createWorkflowManifestSchema() {
  return workflowManifestSchema;
}
