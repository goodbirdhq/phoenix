import {
  CommandId,
  type OrchestrationEvent,
  type ProviderAvailability,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  LimitFailoverReactor,
  type LimitFailoverReactorShape,
} from "../Services/LimitFailoverReactor.ts";

type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type MigrationRefusedEvent = Extract<OrchestrationEvent, { type: "thread.migration-refused" }>;
type FailoverInput = ThreadSessionSetEvent | MigrationRefusedEvent;

const isUsageLimitSessionError = (event: ThreadSessionSetEvent): boolean =>
  event.payload.session.status === "error" &&
  event.payload.session.lastErrorKind === "usage-limit" &&
  event.payload.session.providerInstanceId !== undefined;

/** A session that came up: whatever refused this thread before, it started somewhere since. */
const isSessionStarted = (event: ThreadSessionSetEvent): boolean =>
  event.payload.session.status === "ready";

/**
 * The session window is the short-horizon quota that usage limits interrupt,
 * so target selection ranks by it; a member with no reading at all still
 * beats one that is already limited.
 */
export const remainingScore = (availability: ProviderAvailability): number => {
  if (availability.stale !== undefined) {
    return 0;
  }
  if (availability.status === "limited") {
    return -1;
  }
  if (availability.status === "unknown") {
    return 0;
  }
  const windows = availability.windows.filter((window) => window.usedPercent !== undefined);
  if (windows.length === 0) {
    return 0;
  }
  const sessionWindow = windows.find((window) => window.kind === "session");
  const worst = sessionWindow ?? windows.reduce((a, b) => (a.usedPercent > b.usedPercent ? a : b));
  return 100 - worst.usedPercent;
};

/**
 * Members of `group` that could receive a failing-over thread, excluding the
 * limited instance itself.
 *
 * Enabled state goes through `resolveProviderInstanceEnabled`, not a bare
 * `enabled !== false`: drivers that are off by default (Grok, Cursor,
 * OpenCode) carry no explicit flag, and a bare inequality would fail a
 * thread over onto an instance the server never probed or registered.
 */
export const failoverCandidates = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
  input: {
    readonly originInstanceId: ProviderInstanceId;
    readonly group: string;
    /**
     * Instances that have already refused to take this thread. A refusal is a
     * property of the pair — this thread's resume state against that account —
     * so offering the same target again only reproduces it.
     */
    readonly refusedInstanceIds?: ReadonlySet<string>;
  },
): ReadonlyArray<readonly [string, ProviderInstanceConfig]> =>
  Object.entries(instances).filter(
    ([instanceId, config]) =>
      instanceId !== String(input.originInstanceId) &&
      config.failoverGroup === input.group &&
      resolveProviderInstanceEnabled(config) &&
      input.refusedInstanceIds?.has(instanceId) !== true,
  );

const makeLimitFailoverReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const settingsService = yield* ServerSettingsService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  /**
   * Targets that have refused each thread since its session last came up.
   *
   * "The selection has left the origin" is the only thing absorbing a burst of
   * usage-limit events, and a refusal puts the selection back — so on its own
   * that guard would let every later event in the episode re-pick the same
   * target and be refused again. A refused target is dropped from the thread's
   * candidates instead, so within one episode the set only shrinks and a
   * thread can be handed to each member of its group at most once.
   *
   * The entry is dropped the moment a session for that thread reaches ready.
   * The reactor cannot tell a permanent refusal (an incompatible resume state)
   * from a passing one (a missing worktree, a CLI that failed to spawn), and
   * holding either forever would walk a thread down its group until
   * auto-failover silently stopped working for it. A successful start cannot
   * happen inside a refusal episode — the refusal *is* the start that did not
   * happen — so clearing on one can never reopen the loop.
   */
  const refusedTargetsByThread = new Map<string, Set<string>>();

  const processUsageLimit = Effect.fn("processUsageLimit")(function* (
    event: ThreadSessionSetEvent,
  ) {
    const threadId = event.payload.threadId;
    const originInstanceId = event.payload.session.providerInstanceId;
    if (originInstanceId === undefined) {
      return;
    }
    const settings = yield* settingsService.getSettings;
    const instances = settings.providerInstances ?? {};
    const group = instances[originInstanceId]?.failoverGroup;
    if (group === undefined) {
      // Ungrouped accounts never move automatically; the limit popup owns
      // this moment.
      return;
    }

    // One limit episode can emit several error session-sets. Once the thread's
    // selection has left the limited instance, later events are stale.
    const currentDetail = yield* snapshotQuery.getThreadDetailById(threadId);
    if (
      Option.isNone(currentDetail) ||
      currentDetail.value.modelSelection.instanceId !== originInstanceId
    ) {
      return;
    }

    const refusedInstanceIds = refusedTargetsByThread.get(String(threadId));
    const candidates = failoverCandidates(instances, {
      originInstanceId,
      group,
      ...(refusedInstanceIds !== undefined ? { refusedInstanceIds } : {}),
    });
    // getAvailability is optional on the service shape; a build without it
    // cannot rank, so every non-limited member scores as unknown (0).
    const getAvailability = providerService.getAvailability;
    const scored = yield* Effect.forEach(candidates, ([instanceId, config]) =>
      getAvailability === undefined
        ? Effect.succeed({ instanceId, score: 0 })
        : getAvailability(instanceId as ProviderInstanceId, config.driver).pipe(
            Effect.map((availability) => ({ instanceId, score: remainingScore(availability) })),
          ),
    );
    const target = scored
      .filter((candidate) => candidate.score >= 0)
      .reduce(
        (best, candidate) =>
          best === undefined || candidate.score > best.score ? candidate : best,
        undefined as { instanceId: string; score: number } | undefined,
      );
    if (target === undefined) {
      yield* Effect.logInfo("limit failover found no usable group member", {
        threadId,
        originInstanceId,
        group,
        candidates: candidates.map(([instanceId]) => instanceId),
        refused: [...(refusedInstanceIds ?? [])],
      });
      return;
    }

    yield* Effect.logInfo("limit failover migrating thread", {
      threadId,
      originInstanceId,
      targetInstanceId: target.instanceId,
      group,
    });
    // Command ids derive from the triggering event so a redelivered event
    // upserts the same migration instead of duplicating it. The failed turn's
    // retry is dispatched by the provider command reactor's thread.migrated
    // handler AFTER the session rebinds — dispatching it here raced the
    // restart and tripped the instance guard.
    yield* engine.dispatch({
      type: "thread.migrate",
      commandId: CommandId.make(`limit-failover:${event.eventId}`),
      threadId,
      targetInstanceId: target.instanceId as ProviderInstanceId,
      handoffMode: "replay",
      trigger: "auto-failover",
      createdAt: event.occurredAt,
    });
  });

  /**
   * Refusals ride the same queue as the limits they answer so the memo is
   * always written before the next event is judged against it.
   */
  const processEvent = (event: FailoverInput) => {
    if (event.type === "thread.migration-refused") {
      return Effect.sync(() => {
        const threadId = String(event.payload.threadId);
        const refused = refusedTargetsByThread.get(threadId) ?? new Set<string>();
        refused.add(String(event.payload.attemptedModelSelection.instanceId));
        refusedTargetsByThread.set(threadId, refused);
      });
    }
    if (isSessionStarted(event)) {
      return Effect.sync(() => {
        refusedTargetsByThread.delete(String(event.payload.threadId));
      });
    }
    return isUsageLimitSessionError(event) ? processUsageLimit(event) : Effect.void;
  };

  const processSafely = (event: FailoverInput) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("limit failover reactor failed to process event", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  const start: LimitFailoverReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type === "thread.migration-refused") {
          return worker.enqueue(event);
        }
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        // Ready session-sets are frequent, so only a thread that already holds
        // refusals pays for one; going through the queue keeps the clear
        // ordered against the limits and refusals around it.
        return isUsageLimitSessionError(event) ||
          (isSessionStarted(event) && refusedTargetsByThread.has(String(event.payload.threadId)))
          ? worker.enqueue(event)
          : Effect.void;
      }),
    );
  });

  return { start, drain: worker.drain } satisfies LimitFailoverReactorShape;
});

export const LimitFailoverReactorLive = Layer.effect(
  LimitFailoverReactor,
  makeLimitFailoverReactor,
);
