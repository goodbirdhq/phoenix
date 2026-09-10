/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`,
 * `~/.grok/sessions/**\/updates.jsonl`, and OpenCode's `opencode.db`) rather
 * than relying on Phoenix's own orchestration projections, so usage stays
 * complete even for turns that were never driven through Phoenix. This mirrors
 * the approach `ccusage` takes.
 *
 * Environments return pre-aggregated `(day, hourStart?, provider, model)`
 * buckets. Raw transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 6 as const;
/**
 * Oldest {@link UsageSummary} version a current client will still merge.
 *
 * v5 added `opencode` and v6 added `grok` to {@link UsageProviderKind}; v4
 * Claude/Codex buckets remain valid, so mixed-version environments keep those
 * totals instead of treating every older server as stale.
 */
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals(["claude", "codex", "grok", "opencode"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we matched the model against the LiteLLM rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, hourStart?, provider, model)` cell. `hourStart` is the UTC start
 * instant of a rolling bucket and is present only for hourly requests.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  /**
   * Which {@link UsageSource} on the reporting environment produced this cell.
   *
   * One environment can read several homes for the same provider (a machine
   * with two signed-in Claude accounts, for instance), so provider alone no
   * longer identifies where a bucket came from. Clients drop duplicated
   * directories per source, and need this to drop the right buckets with them.
   *
   * Optional: an environment built before per-source attribution omits it, and
   * clients then fall back to dropping duplicates a whole provider at a time.
   */
  sourceId: Schema.optional(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Identifies the physical provider history store a source read from.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory or database, as
   * `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  /**
   * Identifies this source within its own summary, and nothing beyond it. It
   * is what {@link UsageBucket.sourceId} points at; the fingerprint remains the
   * cross-environment identity. Optional for the same reason as `sourceId`.
   */
  id: Schema.optional(TrimmedNonEmptyString),
  /** Current environment-local instances sharing this history store. This is
   * store membership, not proof of who produced historical records. Absent on
   * older servers; an empty array means no configured instance is associated. */
  configuredInstanceIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

/** Usage within the requested window, grouped by native provider session.
 * Activity bounds are not session creation times or lifetime totals. */
export const UsageSessionModel = Schema.Struct({
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
});
export type UsageSessionModel = typeof UsageSessionModel.Type;

export const UsageThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  createdAt: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  projectTitle: Schema.String,
  projectWorkspaceRoot: Schema.String,
  projectFaviconPath: Schema.NullOr(Schema.String),
});
export type UsageThread = typeof UsageThread.Type;

export const UsageSessionPeriod = Schema.Struct({
  period: TrimmedNonEmptyString,
  costUsd: Schema.Number,
  totalTokens: NonNegativeInt,
});
export type UsageSessionPeriod = typeof UsageSessionPeriod.Type;

export const UsageThreadCreation = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
  instanceId: Schema.NullOr(Schema.String),
});
export type UsageThreadCreation = typeof UsageThreadCreation.Type;

export const UsageSession = Schema.Struct({
  periods: Schema.optional(Schema.Array(UsageSessionPeriod)),
  /** Absent on servers without Phoenix attribution support. */
  attribution: Schema.optional(Schema.Literals(["linked", "unlinked", "ambiguous"])),
  thread: Schema.optional(UsageThread),
  provider: UsageProviderKind,
  sourceId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  firstActivityAt: TrimmedNonEmptyString,
  lastActivityAt: TrimmedNonEmptyString,
  models: Schema.Array(UsageSessionModel),
});
export type UsageSession = typeof UsageSession.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Opt in to session detail; overview clients avoid the extra payload. */
  includeSessions: Schema.optional(Schema.Boolean),
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  /** Defaults to daily for older clients. */
  resolution: Schema.optional(UsageResolution),
  /** Inclusive UTC instant for an hourly rolling window. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant for an hourly rolling window. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /**
   * The provider vocabulary the caller can decode. Absent means version 4,
   * which is what already-deployed clients send.
   */
  contractVersion: Schema.optional(NonNegativeInt),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  /** Absent when not requested or unsupported by an older server. */
  sessionUsage: Schema.optional(Schema.Array(UsageSession)),
  threadCreations: Schema.optional(Schema.Array(UsageThreadCreation)),
  threadCreationSource: Schema.optional(
    Schema.Struct({ hostId: Schema.String, statePath: Schema.String, volumeId: Schema.String }),
  ),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

/**
 * Expresses a summary in the vocabulary an older caller can decode.
 *
 * Version 5 added `opencode`; version 6 adds `grok`. Because providers are a
 * closed literal union, v5 callers receive Claude/Codex/OpenCode and v4 callers
 * receive Claude/Codex. Each response carries the matching contract marker.
 */
export const narrowUsageSummary = (
  summary: UsageSummary,
  contractVersion: number | undefined,
): UsageSummary => {
  const requestedVersion = contractVersion ?? USAGE_MERGE_COMPATIBLE_SINCE;
  if (requestedVersion >= USAGE_CONTRACT_VERSION) {
    return summary;
  }
  const narrowedContractVersion = requestedVersion >= 5 ? 5 : USAGE_MERGE_COMPATIBLE_SINCE;
  const buckets = summary.buckets.filter(
    (bucket) =>
      bucket.provider !== "grok" && (requestedVersion >= 5 || bucket.provider !== "opencode"),
  );
  const sources = summary.sources.filter(
    (source) =>
      source.fingerprint.provider !== "grok" &&
      (requestedVersion >= 5 || source.fingerprint.provider !== "opencode"),
  );
  if (
    summary.contractVersion === narrowedContractVersion &&
    buckets.length === summary.buckets.length &&
    sources.length === summary.sources.length
  ) {
    return summary;
  }
  return {
    ...summary,
    contractVersion: narrowedContractVersion,
    buckets,
    sources,
    ...(summary.sessionUsage === undefined
      ? {}
      : {
          sessionUsage: summary.sessionUsage.filter(
            (session) =>
              session.provider !== "grok" &&
              (requestedVersion >= 5 || session.provider !== "opencode"),
          ),
        }),
  };
};

export class UsageReadError extends Schema.TaggedErrorClass<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
