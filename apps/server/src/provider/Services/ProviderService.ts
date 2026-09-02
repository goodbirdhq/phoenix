/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderAvailability,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderSessionRuntimeLiveness } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/** One configured instance's latest native availability observation. */
export interface ProviderAvailabilityChange {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly availability: ProviderAvailability;
}

/**
 * How many configured instances one availability request may collect from at
 * once. A refresh runs a provider's own CLI, so an environment with several
 * configured instances must neither start them all at once (a burst of child
 * processes, on the machine the user is working on) nor walk them strictly one
 * at a time (a slow instance would hold up every other instance's answer, up to
 * each probe's own timeout). Reads that hit only the cache are unaffected.
 */
export const PROVIDER_AVAILABILITY_FANOUT_CONCURRENCY = 4;

/**
 * The channel a driver reports availability through when it has nothing to
 * report. Kept here rather than in the live layer because the transports build
 * the same fallback when an instance cannot answer at all.
 */
const NATIVE_AVAILABILITY_SOURCES: Partial<Record<string, ProviderAvailability["source"]>> = {
  codex: "codex_app_server",
  claudeAgent: "claude_agent_sdk",
};

/** "This instance told us nothing", in the driver's own native vocabulary. */
export const unknownAvailabilityForDriver = (
  provider: ProviderDriverKind,
): ProviderAvailability => ({
  status: "unknown",
  source: NATIVE_AVAILABILITY_SOURCES[provider] ?? "unsupported",
  windows: [],
});

/**
 * One instance's availability, contained so that it can only ever answer for
 * itself.
 *
 * Availability is collected by fanning out over every configured instance, and
 * the collection is optional enrichment: a person opening Usage, or an agent
 * calling `list_session_providers`, is asking about *all* of their instances.
 * A single adapter that fails — or that throws, which arrives as a defect and
 * would otherwise bypass a typed-error handler entirely and fail the whole
 * `forEach` — must cost that one instance its numbers, not blank every other
 * instance's card. Each element is therefore wrapped here rather than the
 * fan-out as a whole.
 *
 * Interruption is not contained: that is the caller going away, and every
 * element should stop with it.
 *
 * The reading is taken as a thunk so that resolving *which* effect to run is
 * inside the containment too, not only running it.
 */
export const containedAvailability = <E>(
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  read: () => Effect.Effect<ProviderAvailability, E>,
): Effect.Effect<ProviderAvailability> =>
  Effect.suspend(read).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning("provider availability collection failed for one instance", {
            instanceId: input.instanceId,
            provider: input.provider,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(unknownAvailabilityForDriver(input.provider))),
    ),
  );

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /** Runtime/process liveness, not adapter session-map membership. */
  readonly getSessionRuntimeLiveness?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderSessionRuntimeLiveness>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Last native subscription/quota signal for one configured instance.
   * Missing data is represented as an explicit unknown snapshot.
   */
  readonly getAvailability?: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderAvailability>;

  /**
   * Explicit, deduplicated native quota refresh for one configured instance.
   * Callers that fan this out over every configured instance must bound the
   * fan-out with `PROVIDER_AVAILABILITY_FANOUT_CONCURRENCY`.
   */
  readonly refreshAvailability?: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderAvailability>;

  /**
   * Subscribe to cached availability changes without starting provider probes.
   * The subscription acquires its live stream before reading `latest`, so an
   * event arriving during snapshot construction cannot be lost.
   */
  readonly subscribeAvailability?: Effect.Effect<
    {
      readonly latest: ReadonlyArray<ProviderAvailabilityChange>;
      readonly changes: Stream.Stream<ProviderAvailabilityChange>;
    },
    never,
    Scope.Scope
  >;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
