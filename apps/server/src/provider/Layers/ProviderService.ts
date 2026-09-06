import { codexUsageFromSnapshot } from "../codexUsage.ts";
/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderAvailability,
  ProviderUploadFeedbackInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderSessionRuntimeLiveness,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  readProviderAvailabilityCache,
  writeProviderAvailabilityCache,
  type DurableProviderAvailability,
} from "../providerAvailabilityCache.ts";
const isModelSelection = Schema.is(ModelSelection);
const providerAvailabilityEquals = Schema.toEquivalence(ProviderAvailability);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Overrides MCP credential issuance. The real issuer reads a module-global
   * registry that only a running MCP server installs, which makes the
   * agent-browser-access gate unobservable from a unit test; this seam lets a
   * test see whether a credential was requested at all.
   */
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

// The native channels each driver is allowed to speak through. A driver may
// own more than one: Claude reports sparse SDK notifications and, on explicit
// request, the CLI's own `/usage` panel. A cached snapshot whose source is not
// in this list belongs to some other driver and is never presented.
const NATIVE_AVAILABILITY_SOURCES: Partial<
  Record<string, ReadonlyArray<ProviderAvailability["source"]>>
> = {
  codex: ["codex_app_server"],
  grok: ["grok_acp"],
  claudeAgent: ["claude_agent_sdk", "claude_cli_usage"],
};

const isNativeAvailabilitySource = (
  provider: ProviderDriverKind,
  source: ProviderAvailability["source"],
): boolean =>
  source === "unsupported" || (NATIVE_AVAILABILITY_SOURCES[provider] ?? []).includes(source);

// Which channel a silent driver is silent on is one fact, shared with the
// transports that build the same fallback when an instance cannot answer.
const unknownAvailabilityForDriver = ProviderService.unknownAvailabilityForDriver;

// The channel an explicit refresh speaks through, which is not always the
// channel a driver reports passively. Claude's passive source is the Agent SDK,
// but a refresh runs the CLI's `/usage` panel — so a failed refresh has to say
// `claude_cli_usage`, or a client is told the SDK went quiet when in fact the
// CLI read failed.
const REFRESH_AVAILABILITY_SOURCES: Partial<Record<string, ProviderAvailability["source"]>> = {
  claudeAgent: "claude_cli_usage",
  grok: "grok_acp",
};

/**
 * What a refresh reports when the driver could not produce a reading at all.
 * It is still an observation — "at this instant the channel had nothing to
 * say" — so it carries `observedAt`. Without it a client cannot tell a refresh
 * that just failed from an instance that has never been read, and the retained
 * reading it replaces cannot say when the attempt behind it happened.
 */
export const unknownRefreshAvailability = (
  provider: ProviderDriverKind,
  observedAt: string,
): ProviderAvailability => ({
  status: "unknown",
  source: REFRESH_AVAILABILITY_SOURCES[provider] ?? unknownAvailabilityForDriver(provider).source,
  observedAt,
  windows: [],
});

const PROVIDER_AVAILABILITY_MAX_AGE_MS = 15 * 60 * 1_000;
const PROVIDER_AVAILABILITY_REFRESH_COOLDOWN_MS = 30_000;

export type CachedProviderAvailability = {
  readonly driver?: ProviderDriverKind;
  readonly availability: ProviderAvailability;
  readonly receivedAtMs: number;
};

type AvailabilityRefreshClaim = {
  readonly deferred: Deferred.Deferred<ProviderAvailability>;
  readonly owner: boolean;
};

/**
 * What makes two reported windows the same window. Clients key their rendered
 * rows the same way, so a provider that names its pools keeps them distinct
 * everywhere rather than in one layer only.
 */
export const windowIdentityKey = (window: ProviderAvailability["windows"][number]): string =>
  `${window.kind}:${window.scope ?? ""}`;

/**
 * Whether `incoming` is a non-answer that must not displace the reading
 * already in hand. Two cases, both "we learned nothing new on a channel that
 * previously told us something":
 *
 *  - A passive `claude_agent_sdk` ping over a `/usage` reading. The SDK carries
 *    no quota rows today, so it says "the runtime spoke", not "the quota is
 *    unknown"; letting it through would blank the bars a person just asked for,
 *    seconds after they asked.
 *  - A refresh on the *same* channel that came back with nothing. A timed-out
 *    or non-zero-exit CLI call is a fact about the call, not about the
 *    subscription, and throwing away a reading that is still inside its normal
 *    fifteen-minute life would punish a person for pressing refresh.
 *
 * Codex is excluded from the second case because its snapshots merge per
 * window identity below, which already keeps windows a sparse update omitted.
 *
 * An incoming reading that names a *different* account always wins, however
 * empty: showing one account's bars while naming another is worse than showing
 * none. The retained reading is marked stale by the caller and still ages out
 * on its original clock, so a signed-out instance cannot hold bars indefinitely.
 */
const retainsPreviousReading = (
  previous: ProviderAvailability,
  incoming: ProviderAvailability,
): boolean => {
  // A native rejection is authoritative even when the SDK omits the
  // representative window that would let Phoenix draw a quota row.
  if (incoming.status === "limited") return false;
  if (incoming.windows.length > 0) return false;
  if (previous.source === "claude_cli_usage" && incoming.source === "claude_agent_sdk") return true;
  if (previous.source !== incoming.source || incoming.source === "codex_app_server") return false;
  if (previous.windows.length === 0) return false;
  return incoming.account === undefined || incoming.account.id === previous.account?.id;
};

/** Whether a retained reading has to tell clients it is no longer confirmed. */
const staleMarkerFor = (
  previous: ProviderAvailability,
  incoming: ProviderAvailability,
): ProviderAvailability["stale"] | undefined => {
  // A passive ping is not a failed reading: nothing was asked, so nothing
  // failed, and the reading in hand is as good as it was a moment ago.
  if (incoming.source !== previous.source) return undefined;
  return {
    // An attempt that came back with an account reached the provider and simply
    // rendered no rows; one that came back with neither told us nothing at all.
    reason: incoming.account === undefined ? "refresh_failed" : "refresh_empty",
    ...(incoming.observedAt ? { attemptedAt: incoming.observedAt } : {}),
  };
};

export const mergeProviderAvailability = (
  previous: ProviderAvailability | undefined,
  incoming: ProviderAvailability,
): ProviderAvailability => {
  if (previous !== undefined && retainsPreviousReading(previous, incoming)) {
    const stale = staleMarkerFor(previous, incoming);
    // Returned unchanged when there is nothing new to say — identity matters,
    // because the caller uses it to keep the older snapshot's age (see
    // `cacheProviderAvailability`).
    return stale === undefined ? previous : { ...previous, stale };
  }
  if (incoming.source !== "codex_app_server" || previous?.source !== incoming.source) {
    return incoming;
  }
  // Kind alone is not a window identity: a provider can report several windows
  // of one kind, one per pool. Merging on kind would fold a per-model weekly
  // quota into the shared one and report a number that belongs to neither.
  const windows = new Map(previous.windows.map((window) => [windowIdentityKey(window), window]));
  for (const window of incoming.windows) {
    const key = windowIdentityKey(window);
    windows.set(key, { ...windows.get(key), ...window });
  }
  const mergedWindows = [...windows.values()];
  return {
    status: mergedWindows.some((window) => window.usedPercent >= 100)
      ? "limited"
      : mergedWindows.length > 0
        ? "available"
        : "unknown",
    source: incoming.source,
    observedAt: incoming.observedAt,
    // An account identity is only ever as fresh as the snapshot that carried
    // it; a merge never keeps an account the newest reading did not confirm.
    ...(incoming.account ? { account: incoming.account } : {}),
    windows: mergedWindows,
  };
};

/**
 * The cache entry an incoming snapshot produces. Freshness is server-owned:
 * `receivedAtMs` is what `availabilityAt` ages against, so it only advances
 * when the merge actually took something from the incoming snapshot. A ping
 * that carried no reading must not make a fifteen-minute-old `/usage` panel
 * look like it was observed just now.
 */
export const cacheProviderAvailability = (
  cached: CachedProviderAvailability | undefined,
  incoming: ProviderAvailability,
  nowMs: number,
  driver?: ProviderDriverKind,
): CachedProviderAvailability => {
  const availability = mergeProviderAvailability(cached?.availability, incoming);
  if (cached === undefined) {
    return { ...(driver ? { driver } : {}), availability, receivedAtMs: nowMs };
  }
  const nextDriver = driver ?? cached.driver;
  if (
    nextDriver === cached.driver &&
    providerAvailabilityEquals(cached.availability, availability)
  ) {
    return cached;
  }
  // A retained reading keeps the age it already had, whether or not it picked
  // up a stale marker on the way through. Restamping it would let a run of
  // failed refreshes keep a single old panel alive forever.
  if (retainsPreviousReading(cached.availability, incoming)) {
    return availability === cached.availability ? cached : { ...cached, availability };
  }
  return {
    ...((driver ?? cached.driver) ? { driver: driver ?? cached.driver } : {}),
    availability,
    receivedAtMs: nowMs,
  };
};

export const availabilityAt = (
  cached: CachedProviderAvailability | undefined,
  provider: ProviderDriverKind,
  nowMs: number,
): ProviderAvailability => {
  if (cached === undefined) return unknownAvailabilityForDriver(provider);
  if (cached.driver !== undefined && cached.driver !== provider) {
    return unknownAvailabilityForDriver(provider);
  }
  if (!isNativeAvailabilitySource(provider, cached.availability.source)) {
    return unknownAvailabilityForDriver(provider);
  }
  if (nowMs - cached.receivedAtMs <= PROVIDER_AVAILABILITY_MAX_AGE_MS) {
    return cached.availability;
  }
  // Freshness decides whether a read should revalidate, not whether Phoenix
  // forgets the last observation. Keeping the windows here lets a stale
  // revalidation run without blanking the account and quota rows the user was
  // already looking at; the unknown status is the existing-decodable signal
  // used by refresh planning.
  return { ...cached.availability, status: "unknown" };
};

/**
 * Drop per-instance state for adapters that were replaced or removed, so a
 * rebuilt instance never inherits the previous process's quota reading or its
 * refresh cooldown. Entries are keyed by instance id in both maps.
 */
export const retainStateForReconciledAdapters = <Value, Adapter>(
  entries: ReadonlyMap<ProviderInstanceId, Value>,
  previous: ReadonlyMap<ProviderInstanceId, Adapter>,
  next: ReadonlyMap<ProviderInstanceId, Adapter>,
): Map<ProviderInstanceId, Value> => {
  const retained = new Map(entries);
  for (const [id, previousAdapter] of previous) {
    if (next.get(id) !== previousAdapter) retained.delete(id);
  }
  for (const id of retained.keys()) {
    if (!next.has(id)) retained.delete(id);
  }
  return retained;
};

export const clearAvailabilityForReconciledAdapters = <Adapter>(
  entries: ReadonlyMap<ProviderInstanceId, CachedProviderAvailability>,
  previous: ReadonlyMap<ProviderInstanceId, Adapter>,
  next: ReadonlyMap<ProviderInstanceId, Adapter>,
): Map<ProviderInstanceId, CachedProviderAvailability> =>
  retainStateForReconciledAdapters(entries, previous, next);

/**
 * Decide, in one step, whether this caller owns the next refresh of
 * `instanceId` and what the cooldown map becomes. Callers apply it inside a
 * single `Ref.modify`: a read-then-write would let two clients that clicked at
 * the same moment both pass the check and spawn the provider CLI twice.
 */
export const claimAvailabilityRefresh = (
  entries: ReadonlyMap<ProviderInstanceId, number>,
  instanceId: ProviderInstanceId,
  nowMs: number,
): readonly [claimed: boolean, entries: ReadonlyMap<ProviderInstanceId, number>] => {
  const lastRefreshMs = entries.get(instanceId);
  if (
    lastRefreshMs !== undefined &&
    nowMs - lastRefreshMs < PROVIDER_AVAILABILITY_REFRESH_COOLDOWN_MS
  ) {
    return [false, entries];
  }
  const next = new Map(entries);
  next.set(instanceId, nowMs);
  return [true, next];
};

const toIsoDateTime = (unixSeconds: unknown): string | undefined => {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(unixSeconds * 1000));
};

const claudeWindowIdentity = (
  rateLimitType: unknown,
): Omit<ProviderAvailability["windows"][number], "usedPercent" | "resetsAt"> | undefined => {
  switch (rateLimitType) {
    case "five_hour":
      return { kind: "session", label: "Current session", windowDurationMins: 5 * 60 };
    case "seven_day":
      return {
        kind: "weekly",
        label: "Current week",
        scope: "all-models",
        windowDurationMins: 7 * 24 * 60,
      };
    case "seven_day_opus":
      return {
        kind: "model-weekly",
        label: "Opus",
        scope: "opus",
        windowDurationMins: 7 * 24 * 60,
      };
    case "seven_day_sonnet":
      return {
        kind: "model-weekly",
        label: "Sonnet",
        scope: "sonnet",
        windowDurationMins: 7 * 24 * 60,
      };
    case "seven_day_overage_included":
      return { kind: "seven_day_overage_included", windowDurationMins: 7 * 24 * 60 };
    case "overage":
      return { kind: "overage" };
    default:
      return undefined;
  }
};

const claudeAvailabilityFromRateLimitEvent = (
  event: Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>,
): ProviderAvailability | undefined => {
  const rateLimitEvent = event.payload.rateLimits;
  if (typeof rateLimitEvent !== "object" || rateLimitEvent === null) return undefined;
  const info = (rateLimitEvent as Record<string, unknown>).rate_limit_info;
  if (typeof info !== "object" || info === null) return undefined;
  const fields = info as Record<string, unknown>;
  const nativeStatus = fields.status;
  if (
    nativeStatus !== "allowed" &&
    nativeStatus !== "allowed_warning" &&
    nativeStatus !== "rejected"
  ) {
    return undefined;
  }

  const identity = claudeWindowIdentity(fields.rateLimitType);
  const utilization = fields.utilization;
  const usedPercent =
    nativeStatus === "rejected"
      ? 100
      : typeof utilization === "number" &&
          Number.isFinite(utilization) &&
          utilization >= 0 &&
          utilization <= 1
        ? Math.round(utilization * 1_000) / 10
        : undefined;
  const resetsAt = toIsoDateTime(fields.resetsAt);
  const windows =
    identity && usedPercent !== undefined
      ? [{ ...identity, usedPercent, ...(resetsAt ? { resetsAt } : {}) }]
      : [];

  return {
    status: nativeStatus === "rejected" ? "limited" : "available",
    source: "claude_agent_sdk",
    observedAt: event.createdAt,
    windows,
  };
};

// Codex's app-server schema is authoritative here. It calls the two windows
// primary/secondary, so we preserve that wording instead of guessing that a
// given plan always means five-hour/weekly.
export const availabilityFromRuntimeEvent = (
  event: ProviderRuntimeEvent,
): ProviderAvailability | undefined => {
  if (event.type !== "account.rate-limits.updated") return undefined;
  if (event.provider === "codex") {
    const payload = event.payload.rateLimits;
    if (typeof payload !== "object" || payload === null || !("rateLimits" in payload))
      return undefined;
    const snapshot = payload.rateLimits;
    if (typeof snapshot !== "object" || snapshot === null) return undefined;
    return codexUsageFromSnapshot(snapshot, event.createdAt);
  }
  // Claude's SDK event is deliberately less stable than Codex's documented
  // app-server schema. Preserve native provenance and only derive fields the
  // event identifies explicitly; an unrecognized shape remains unknown.
  if (event.provider === "claudeAgent") {
    return (
      claudeAvailabilityFromRateLimitEvent(event) ?? {
        status: "unknown",
        source: "claude_agent_sdk",
        observedAt: event.createdAt,
        windows: [],
      }
    );
  }
  return undefined;
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issueMcpCredential =
    options?.issueMcpCredential ?? McpSessionRegistry.issueActiveMcpCredential;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const availabilityChangesPubSub =
    yield* PubSub.unbounded<ProviderService.ProviderAvailabilityChange>();
  const availabilityCachePath = path.join(serverConfig.stateDir, "provider-availability.json");
  const persistedAvailability = yield* readProviderAvailabilityCache(availabilityCachePath);
  const availabilityByInstance = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, CachedProviderAvailability>
  >(new Map(persistedAvailability));
  const lastAvailabilityRefreshAt = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(
    new Map(),
  );
  const availabilityRefreshes = yield* Ref.make(
    new Map<ProviderInstanceId, Deferred.Deferred<ProviderAvailability>>(),
  );
  // Every entry point (web, MCP, or another future client) shares this bound.
  // Per-request fan-out alone cannot prevent several concurrent targeted RPCs
  // from spawning every provider CLI at once.
  const availabilityRefreshPermits = yield* Semaphore.make(
    ProviderService.PROVIDER_AVAILABILITY_FANOUT_CONCURRENCY,
  );
  const availabilityPersistence = yield* Semaphore.make(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const persistAvailability = availabilityPersistence.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(availabilityByInstance);
      const durable = new Map<ProviderInstanceId, DurableProviderAvailability>();
      for (const [instanceId, entry] of current) {
        if (entry.driver !== undefined) {
          durable.set(instanceId, { ...entry, driver: entry.driver });
        }
      }
      yield* writeProviderAvailabilityCache({
        filePath: availabilityCachePath,
        entries: durable,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist provider availability cache", {
          path: availabilityCachePath,
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  // Returns the stored entry, so a caller can answer with exactly what a
  // subsequent read of this instance returns rather than with the snapshot it
  // handed in. Persistence reads the latest Ref value under one permit, so
  // overlapping passive events cannot finish their disk writes out of order.
  const cacheAvailability = (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
    availability: ProviderAvailability,
    nowMs: number,
  ) =>
    Ref.modify(
      availabilityByInstance,
      (
        entries,
      ): readonly [
        { readonly entry: CachedProviderAvailability; readonly changed: boolean },
        ReadonlyMap<ProviderInstanceId, CachedProviderAvailability>,
      ] => {
        const previous = entries.get(instanceId);
        const entry = cacheProviderAvailability(previous, availability, nowMs, provider);
        if (entry === previous) {
          return [{ entry, changed: false }, entries] as const;
        }
        const next = new Map(entries);
        next.set(instanceId, entry);
        return [{ entry, changed: true }, next] as const;
      },
    ).pipe(
      Effect.tap(({ changed }) => (changed ? persistAvailability : Effect.void)),
      Effect.tap(({ changed, entry }) =>
        changed
          ? PubSub.publish(availabilityChangesPubSub, {
              instanceId,
              provider,
              availability: availabilityAt(entry, provider, nowMs),
            })
          : Effect.void,
      ),
      Effect.map(({ entry }) => entry),
    );
  /**
   * Attach the `phoenix` MCP server to the session that is about to start.
   *
   * The shared MCP server carries independent preview and session-orchestration
   * capabilities. Always attach it here; each toolkit enforces its own dynamic
   * server setting when a tool is invoked.
   */
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const credential = yield* issueMcpCredential({ threadId, providerInstanceId });
      if (credential) {
        yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      }
      return credential;
    });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> => {
    const ingest = Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.tap((canonicalEvent) => {
        const threadId = canonicalEvent.threadId;
        return threadId === undefined
          ? Effect.void
          : Effect.flatMap(nowIso, (observedAt) =>
              directory.recordActivity(threadId, source.instanceId, observedAt),
            );
      }),
      Effect.tap((canonicalEvent) => {
        const availability = availabilityFromRuntimeEvent(canonicalEvent);
        return availability
          ? Effect.flatMap(DateTime.now, (now) =>
              cacheAvailability(
                source.instanceId,
                source.provider,
                availability,
                DateTime.toEpochMillis(now),
              ),
            )
          : Effect.void;
      }),
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );
    return Ref.get(subscribedAdapters).pipe(
      Effect.flatMap((adapters) =>
        adapters.get(source.instanceId) === source.adapter ? ingest : Effect.void,
      ),
    );
  };

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  const refreshAvailability = (instanceId: ProviderInstanceId, provider: ProviderDriverKind) =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const cachedAt = () =>
        Effect.map(Ref.get(availabilityByInstance), (entries) =>
          availabilityAt(entries.get(instanceId), provider, now),
        );
      // Resolve the adapter before claiming the cooldown: an instance whose
      // driver cannot refresh should not burn the next thirty seconds of the
      // one that can.
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (
        Option.isNone(adapter) ||
        adapter.value.provider !== provider ||
        !adapter.value.refreshAvailability
      ) {
        return yield* cachedAt();
      }
      const collectAvailability = adapter.value.refreshAvailability;
      const deferred = yield* Deferred.make<ProviderAvailability>();
      const refresh = yield* Ref.modify(availabilityRefreshes, (entries) => {
        const existing = entries.get(instanceId);
        if (existing !== undefined) {
          return [
            { deferred: existing, owner: false } as AvailabilityRefreshClaim,
            entries,
          ] as const;
        }
        const next = new Map(entries);
        next.set(instanceId, deferred);
        return [{ deferred, owner: true } as AvailabilityRefreshClaim, next] as const;
      });
      if (!refresh.owner) {
        return yield* Deferred.await(refresh.deferred);
      }

      return yield* Effect.gen(function* () {
        const claimed = yield* Ref.modify(lastAvailabilityRefreshAt, (entries) =>
          claimAvailabilityRefresh(entries, instanceId, now),
        );
        if (!claimed) {
          return yield* cachedAt();
        }
        const availability = yield* availabilityRefreshPermits
          .withPermits(1)(collectAvailability())
          .pipe(
            // A refresh that failed reports the channel it failed on, not the
            // driver's passive one. The whole cause is caught, not just the typed
            // error: an adapter that throws while shelling out to its CLI is a
            // defect, and a defect escaping here would take down the caller's
            // whole availability fan-out over one misbehaving instance.
            // Interruption is the caller going away and stays a cancellation.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.logWarning("provider availability refresh failed", {
                    instanceId,
                    provider,
                    cause,
                  }).pipe(
                    Effect.andThen(DateTime.now),
                    Effect.map((failedAt) =>
                      unknownRefreshAvailability(provider, DateTime.formatIso(failedAt)),
                    ),
                  ),
            ),
          );
        // Stamped when the reading came back rather than when the request
        // started: the CLI call itself can take seconds. Answering through
        // `availabilityAt` keeps one owner of freshness — a refresh reports what
        // the cache now holds, never a snapshot the cache would not present.
        const receivedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        const entry = yield* cacheAvailability(instanceId, provider, availability, receivedAtMs);
        return availabilityAt(entry, provider, receivedAtMs);
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Ref.update(availabilityRefreshes, (entries) => {
              if (entries.get(instanceId) !== deferred) return entries;
              const next = new Map(entries);
              next.delete(instanceId);
              return next;
            });
            yield* Exit.isSuccess(exit)
              ? Deferred.succeed(deferred, exit.value)
              : Deferred.succeed(deferred, yield* cachedAt());
          }),
        ),
      );
    });

  const subscribeAvailability: ProviderService.ProviderService["Service"]["subscribeAvailability"] =
    Effect.gen(function* () {
      // Register before reading the cache so a passive event cannot land in
      // the gap between the initial snapshot and the live stream.
      const subscription = yield* PubSub.subscribe(availabilityChangesPubSub);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const latest = yield* Ref.get(availabilityByInstance).pipe(
        Effect.map((entries) =>
          [...entries].flatMap(([instanceId, entry]) =>
            entry.driver === undefined
              ? []
              : [
                  {
                    instanceId,
                    provider: entry.driver,
                    availability: availabilityAt(entry, entry.driver, nowMs),
                  } satisfies ProviderService.ProviderAvailabilityChange,
                ],
          ),
        ),
      );
      return { latest, changes: Stream.fromSubscription(subscription) };
    });

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
    }
    // Publish the next adapter identities before admitting any events. That
    // makes late buffered events from a replaced adapter harmless, then the
    // cache reset cannot erase an initial signal from its replacement.
    yield* Ref.set(subscribedAdapters, next);
    yield* Ref.update(availabilityByInstance, (entries) => {
      const retained = clearAvailabilityForReconciledAdapters(entries, previous, next);
      for (const [instanceId, entry] of retained) {
        const adapter = next.get(instanceId);
        if (entry.driver !== undefined && adapter?.provider !== entry.driver) {
          retained.delete(instanceId);
        }
      }
      return retained;
    });
    // The cooldown map is keyed by instance id too; without the same pruning it
    // keeps a timestamp per instance that ever existed and would silence the
    // first refresh of a rebuilt instance.
    yield* Ref.update(lastAvailabilityRefreshAt, (entries) =>
      retainStateForReconciledAdapters(entries, previous, next),
    );
    for (const [id, adapter] of next) {
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
              adapter,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* persistAvailability;
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in Phoenix settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId);
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        // Changing runtime mode restarts the session, so the transition is only
        // observable here, by diffing against the mode the previous session for
        // this thread was bound to. Recording it separately is what makes the
        // "started supervised, switched to full access" funnel answerable.
        const previousRuntimeMode = persistedBinding?.runtimeMode;
        if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
          yield* analytics.record("provider.runtime_mode.changed", {
            provider: sessionWithInstance.provider,
            from: previousRuntimeMode,
            to: input.runtimeMode,
          });
        }

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0 && parsed.continuation !== true) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    const inputTextWithCitations =
      parsed.input === undefined ? undefined : expandAssistantCitationsForProvider(parsed.input);
    if (inputTextWithCitations !== parsed.input) {
      yield* decodeInputOrValidationError({
        operation: "ProviderService.sendTurn",
        schema: ProviderSendTurnInput.fields.input,
        payload: inputTextWithCitations,
      });
    }

    // Every attachment gets an on-disk path in the prompt so the model's tools
    // can dereference the actual file. All attachments then go to the adapter,
    // and each adapter decides what its provider ingests natively: OpenCode
    // sends generic files as file parts, the others send images only and rely
    // on the path line for everything else. Unresolvable ids are skipped here
    // and surface as adapter errors when the file is read.
    const attachmentPathLines = attachments.flatMap((attachment) => {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      return attachmentPath === null
        ? []
        : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
    });
    const inputTextWithAttachmentPaths =
      attachmentPathLines.length === 0
        ? inputTextWithCitations
        : [inputTextWithCitations, attachmentPathLines.join("\n")]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");

    const input = {
      ...parsed,
      ...(inputTextWithAttachmentPaths !== undefined
        ? { input: inputTextWithAttachmentPaths }
        : {}),
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: false,
      });
      if (
        input.continuation === true &&
        !input.input &&
        attachments.length === 0 &&
        routed.adapter.capabilities.promptlessTurnContinuation !== true
      ) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          `Provider '${routed.adapter.provider}' requires an explicit continuation prompt`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
      }
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        // Session-start events alone skew runtime mode toward users who toggle
        // often, since every toggle restarts the session. Recording it per turn
        // gives a usage-weighted view and lets it cross with interactionMode.
        runtimeMode: routed.runtimeMode,
        attachmentCount: attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      // Only live adapter sessions appear in this response. Resolving every
      // historical binding here makes each call scale with the full thread
      // history instead of the active session set.
      const persistedBindings = yield* Effect.forEach(
        [...new Set(activeSessions.map((session) => session.threadId))],
        (threadId) =>
          directory
            .getBinding(threadId)
            .pipe(
              Effect.orElseSucceed(() =>
                Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getSessionRuntimeLiveness: NonNullable<
    ProviderService.ProviderService["Service"]["getSessionRuntimeLiveness"]
  > = (threadId) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(
        yield* directory.getBinding(threadId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (!binding) return "dead" as ProviderSessionRuntimeLiveness;
      if (!binding.providerInstanceId) return "dead" as ProviderSessionRuntimeLiveness;
      const adapter = yield* registry.getByInstance(binding.providerInstanceId).pipe(Effect.option);
      if (Option.isNone(adapter)) return "dead" as ProviderSessionRuntimeLiveness;
      return adapter.value.getSessionRuntimeLiveness
        ? yield* adapter.value.getSessionRuntimeLiveness(threadId)
        : ("unknown" as ProviderSessionRuntimeLiveness);
    });

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const uploadFeedback: ProviderServiceMethod<"uploadFeedback"> = Effect.fn("uploadFeedback")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.uploadFeedback",
        schema: ProviderUploadFeedbackInput,
        payload: rawInput,
      });
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.uploadFeedback",
        allowRecovery: false,
      });
      if (routed.adapter.uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.uploadFeedback",
          allowRecovery: true,
        });
      }
      const uploadFeedback = routed.adapter.uploadFeedback;
      if (uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "upload-feedback",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* uploadFeedback(input);
    },
  );

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getSessionRuntimeLiveness,
    getCapabilities,
    getInstanceInfo,
    getAvailability: (instanceId, provider) =>
      Effect.flatMap(DateTime.now, (now) =>
        Ref.get(availabilityByInstance).pipe(
          Effect.map((entries) =>
            availabilityAt(entries.get(instanceId), provider, DateTime.toEpochMillis(now)),
          ),
        ),
      ),
    refreshAvailability,
    subscribeAvailability,
    rollbackConversation,
    uploadFeedback,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
).pipe(Layer.provide(NodeServices.layer));

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options)).pipe(
    Layer.provide(NodeServices.layer),
  );
}
