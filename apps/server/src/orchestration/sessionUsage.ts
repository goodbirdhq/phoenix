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
 * trusts its shape.
 *
 * `lastTurnInputTokens`/`lastTurnOutputTokens` are the most recent turn's
 * counts — both adapters populate `inputTokens`/`outputTokens` on this
 * payload from their own "last turn" usage, never a session accumulation.
 *
 * `totalTokens` is sourced ONLY from `totalProcessedTokens` — a provider's
 * own cumulative counter — and omitted (not backfilled from `usedTokens`)
 * when a provider has not reported one. `usedTokens` is context-window
 * occupancy: bounded by the window and it goes down after compaction, so
 * using it as a stand-in for cumulative spend would be actively misleading.
 */
export function tokensFromContextWindowPayload(payload: unknown): {
  readonly lastTurnInputTokens: number | null;
  readonly lastTurnOutputTokens: number | null;
  readonly totalTokens: number | null;
} {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  return {
    lastTurnInputTokens: finiteNonNegativeInt(record?.inputTokens),
    lastTurnOutputTokens: finiteNonNegativeInt(record?.outputTokens),
    totalTokens: finiteNonNegativeInt(record?.totalProcessedTokens),
  };
}

// Date.parse returns NaN for an unparseable timestamp; Math.max(0, NaN) is
// still NaN. elapsedMs is the one always-present field on the wire (an
// IsoDateTime-typed NonNegativeInt), so letting a bad clock value through as
// NaN would fail ping_session's schema encode outright, or — for a posted
// report, where usage rides in the same JSON blob as findings/validation/
// recommendation/completionPercent — get silently dropped by the lenient
// decoder along with every other structured field. Guarded so one bad
// timestamp degrades to "0" instead of voiding the rest of the report.
export function elapsedMsSince(createdAt: string, now: string): number {
  const createdMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  return Math.max(0, nowMs - createdMs);
}

export function lastTurnDurationMsFromTurn(
  latestTurn: Pick<OrchestrationLatestTurn, "startedAt" | "completedAt"> | null,
): number | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }
  const startedMs = Date.parse(latestTurn.startedAt);
  const completedMs = Date.parse(latestTurn.completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return null;
  }
  return Math.max(0, completedMs - startedMs);
}

/**
 * Pure assembly of a SessionUsageSnapshot from already-resolved parts.
 * Every field but `elapsedMs` is omitted (not null) when unavailable, so the
 * wire payload only carries what is actually known.
 */
export function buildSessionUsageSnapshot(input: {
  readonly tokens: {
    readonly lastTurnInputTokens: number | null;
    readonly lastTurnOutputTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly turnCount: number | null;
  readonly elapsedMs: number;
  readonly lastTurnDurationMs: number | null;
}): SessionUsageSnapshot {
  return {
    ...(input.tokens.lastTurnInputTokens !== null
      ? { lastTurnInputTokens: input.tokens.lastTurnInputTokens }
      : {}),
    ...(input.tokens.lastTurnOutputTokens !== null
      ? { lastTurnOutputTokens: input.tokens.lastTurnOutputTokens }
      : {}),
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
