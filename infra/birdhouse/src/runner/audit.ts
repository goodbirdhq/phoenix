import type { DbOrTx } from "../db/client.ts";
import { auditEvent } from "../db/schema.ts";

export type AuditOutcome = "attempted" | "succeeded" | "denied" | "failed";

export interface WriteAuditEventInput {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditOutcome;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/** Thin insert wrapper so every runner/http call site writes the same shape. */
export async function writeAuditEvent(db: DbOrTx, input: WriteAuditEventInput): Promise<void> {
  await db.insert(auditEvent).values({
    actor: input.actor,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
  });
}
