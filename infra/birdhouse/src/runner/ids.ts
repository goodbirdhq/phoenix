import { createHash } from "node:crypto";

/**
 * Deterministic per-run Phoenix ids (threadId, thread.create/turn.start
 * commandIds, the turn's messageId), derived from the run id alone.
 *
 * Why deterministic rather than freshly generated and persisted: the job
 * queue's retry model re-runs `workflow.launch` from scratch on crash or
 * transient failure, and the Phoenix contract's idempotency guarantee is
 * keyed on (commandId, aggregate) — replaying the same commandId against the
 * same threadId returns the original `{sequence}` instead of creating a
 * duplicate thread/turn (docs/phoenix-http-contract.md §Idempotency).
 * Deriving every id from `runId` means a crash between "built the command"
 * and "dispatched it" needs zero extra persisted state to retry safely: the
 * next attempt recomputes the exact same ids and Phoenix recognizes the
 * replay.
 *
 * The one thing this can't survive is a *validation* rejection (400) of a
 * command that was actually malformed — the contract says a rejected
 * commandId is permanently "rejected", and retrying needs a fresh commandId.
 * Since these ids are pure functions of runId, there is no fresh variant to
 * fall back to; a validation rejection here is treated as terminal for the
 * run (see handlers.ts) rather than retried.
 */
export interface RunPhoenixIds {
  threadId: string;
  createCommandId: string;
  turnCommandId: string;
  messageId: string;
}

function deterministicUuid(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 4122-shaped, not RFC 4122-derived: version nibble forced to 5
  // ("name-based") and variant bits set, purely so the value passes any
  // "looks like a uuid" validation. Phoenix ids are just trimmed non-empty
  // strings on the wire (see packages/contracts/src/baseSchemas.ts
  // `makeEntityId`), but there is no reason not to look the part.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveRunPhoenixIds(runId: string): RunPhoenixIds {
  return {
    threadId: deterministicUuid(`${runId}:thread`),
    createCommandId: deterministicUuid(`${runId}:create`),
    turnCommandId: deterministicUuid(`${runId}:turn`),
    messageId: deterministicUuid(`${runId}:message`),
  };
}
