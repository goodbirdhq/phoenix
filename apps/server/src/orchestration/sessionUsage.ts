/**
 * Best-effort session usage snapshot for orchestrating parents.
 *
 * Reuses the same provider-usage projection the web client's context-window
 * meter already reads (`projection_thread_activities` rows of kind
 * "context-window.updated", written by ProviderRuntimeIngestion from the
 * provider adapters' `thread.token-usage.updated` events) plus two bounded,
 * single-purpose queries — no new provider plumbing. Deliberately no cost
 * estimate: price tables go stale, so tokens are the stable currency and
 * cost-in-client is the pattern.
 *
 * @module sessionUsage
 */
import type { OrchestrationLatestTurn, SessionUsageSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function finiteNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * Extracts token counts from a `context-window.updated` activity payload.
 * Mirrors apps/web/src/lib/contextWindow.ts's defensive reading: the payload
 * is Schema.Unknown end to end (see ThreadTokenUsageSnapshot), so this never
 * trusts its shape. `totalTokens` prefers `totalProcessedTokens` (the
 * cumulative session total a provider reports after compaction) and falls
 * back to `usedTokens` (current context-window fill) otherwise.
 */
export function tokensFromContextWindowPayload(payload: unknown): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
} {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  return {
    inputTokens: finiteNonNegativeInt(record?.inputTokens),
    outputTokens: finiteNonNegativeInt(record?.outputTokens),
    totalTokens:
      finiteNonNegativeInt(record?.totalProcessedTokens) ??
      finiteNonNegativeInt(record?.usedTokens),
  };
}

export function elapsedMsSince(createdAt: string, now: string): number {
  return Math.max(0, Date.parse(now) - Date.parse(createdAt));
}

export function lastTurnDurationMsFromTurn(
  latestTurn: Pick<OrchestrationLatestTurn, "startedAt" | "completedAt"> | null,
): number | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }
  return Math.max(0, Date.parse(latestTurn.completedAt) - Date.parse(latestTurn.startedAt));
}

/**
 * Pure assembly of a SessionUsageSnapshot from already-resolved parts.
 * Every field but `elapsedMs` is omitted (not null) when unavailable, so the
 * wire payload only carries what is actually known.
 */
export function buildSessionUsageSnapshot(input: {
  readonly tokens: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly turnCount: number | null;
  readonly elapsedMs: number;
  readonly lastTurnDurationMs: number | null;
}): SessionUsageSnapshot {
  return {
    ...(input.tokens.inputTokens !== null ? { inputTokens: input.tokens.inputTokens } : {}),
    ...(input.tokens.outputTokens !== null ? { outputTokens: input.tokens.outputTokens } : {}),
    ...(input.tokens.totalTokens !== null ? { totalTokens: input.tokens.totalTokens } : {}),
    ...(input.turnCount !== null ? { turnCount: input.turnCount } : {}),
    elapsedMs: input.elapsedMs,
    ...(input.lastTurnDurationMs !== null ? { lastTurnDurationMs: input.lastTurnDurationMs } : {}),
  };
}

/**
 * Resolves a thread's usage snapshot for ping_session/post_report. Each read
 * is bounded (one row or one aggregate) and degrades to "unknown" on its own
 * failure — a usage lookup is optional enrichment and must never fail the
 * caller, the same contract as ping_session's other purpose-built reads.
 */
export const resolveSessionUsageSnapshot = (
  snapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getLatestUsageActivity" | "getThreadTurnCount"
  >,
  input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly latestTurn: Pick<OrchestrationLatestTurn, "startedAt" | "completedAt"> | null;
  },
): Effect.Effect<SessionUsageSnapshot> =>
  Effect.gen(function* () {
    const now = yield* nowIso;
    const usagePayload = yield* snapshotQuery.getLatestUsageActivity(input.threadId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    const turnCount = yield* snapshotQuery
      .getThreadTurnCount(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    return buildSessionUsageSnapshot({
      tokens: tokensFromContextWindowPayload(usagePayload),
      turnCount,
      elapsedMs: elapsedMsSince(input.createdAt, now),
      lastTurnDurationMs: lastTurnDurationMsFromTurn(input.latestTurn),
    });
  });
