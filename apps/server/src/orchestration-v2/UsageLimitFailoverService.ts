import {
  CommandId,
  MessageId,
  ProviderFailoverGroup,
  providerFailoverGroupFor,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import { latestRootProviderFailure, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type UsageLimitFailoverOutcome =
  | {
      readonly type: "switched";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly fromInstanceId: ProviderInstanceId;
      readonly toInstanceId: ProviderInstanceId;
    }
  | {
      /** Every other member is limited, disabled, or refused; the thread waits for the reset. */
      readonly type: "exhausted";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly fromInstanceId: ProviderInstanceId;
    };

export class UsageLimitFailoverService extends Context.Service<
  UsageLimitFailoverService,
  {
    /**
     * Moves each thread a usage limit blocks, on an account in a `switch`
     * group, to the next member of that group and continues its failed run
     * there. Threads it cannot move are left for `UsageLimitRecoveryWorker`.
     */
    readonly sweep: () => Effect.Effect<
      ReadonlyArray<UsageLimitFailoverOutcome>,
      ProjectionStore.ProjectionStoreV2Error | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/UsageLimitFailoverService") {}

const encodeGroup = Schema.encodeSync(Schema.fromJsonString(ProviderFailoverGroup));

/** The members after `current` in group order, then the ones before it. */
function failoverOrder(group: ProviderFailoverGroup, current: ProviderInstanceId) {
  const index = group.instanceIds.indexOf(current);
  return [...group.instanceIds.slice(index + 1), ...group.instanceIds.slice(0, index)];
}

/**
 * Accounts the thread's current limit episode has already hit: those of its
 * trailing usage-limited runs. A run that ended any other way closes the
 * episode, so an account whose window has reset since becomes eligible again,
 * while within an episode each member is tried at most once.
 */
function limitedInEpisode(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlySet<ProviderInstanceId> {
  const executed = runs
    .filter((run) => run.status !== "queued" && !(run.status === "cancelled" && !run.startedAt))
    .toSorted((left, right) => (runRanAfter(left, right) ? -1 : 1));
  const limited = new Set<ProviderInstanceId>();
  for (const run of executed) {
    if (latestRootProviderFailure(run, turnItems)?.class !== "usage_limit") break;
    limited.add(run.providerInstanceId);
  }
  return limited;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const providerSwitch = yield* ProviderSwitchService.ProviderSwitchServiceV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  // An exhausted thread stays a candidate until its limit resets; remembering
  // the group it was judged against spares reloading its runs every tick.
  const exhausted = yield* Ref.make(new Map<RunId, string>());

  const failover = Effect.fn("UsageLimitFailoverService.failover")(function* (
    candidate: ProjectionStore.ProjectionLimitFailoverCandidate,
    group: ProviderFailoverGroup,
    preferences: ServerSettingsValue,
  ) {
    const { thread, runId } = candidate;
    const from = thread.modelSelection.instanceId;
    const { runs, turnItems } = yield* projections.getThreadRecords(
      thread.id,
      ["runs", "turnItems"],
      { turnItemTypes: ["error"] },
    );
    const limited = limitedInEpisode(runs, turnItems);
    const fromDriver = Option.map(
      yield* Effect.option(adapters.get(from)),
      (adapter) => adapter.driver,
    );
    for (const to of failoverOrder(group, from)) {
      if (limited.has(to)) continue;
      if (!resolveProjectProviderInstanceEnabled(preferences, thread.projectId, to)) continue;
      const target = yield* Effect.option(adapters.get(to));
      // Model ids and options belong to a driver, so a group only moves
      // threads between accounts of the same one.
      if (Option.isNone(target) || Option.getOrNull(fromDriver) !== target.value.driver) continue;
      const modelSelection = { ...thread.modelSelection, instanceId: to };
      const plan = yield* projections.getThreadProviderContext(thread.id, to).pipe(
        Effect.flatMap((projection) =>
          providerSwitch.plan({ projection, targetModelSelection: modelSelection }),
        ),
        Effect.option,
      );
      if (Option.isNone(plan)) continue;
      const identity = `${thread.id}:${runId}:${to}`;
      const dispatched = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`limit-failover:${identity}`),
          messageId: MessageId.make(`limit-failover:${identity}`),
          threadId: thread.id,
          manualContinuationOfRunId: runId,
          modelSelection,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
              threadId: thread.id,
              toInstanceId: to,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!dispatched) continue;
      return {
        type: "switched",
        threadId: thread.id,
        runId,
        fromInstanceId: from,
        toInstanceId: to,
      } satisfies UsageLimitFailoverOutcome;
    }
    return {
      type: "exhausted",
      threadId: thread.id,
      runId,
      fromInstanceId: from,
    } satisfies UsageLimitFailoverOutcome;
  });

  const sweep = Effect.fn("UsageLimitFailoverService.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const switching = preferences.failoverGroups.filter(
      (group) => group.onUsageLimit === "switch" && group.instanceIds.length > 1,
    );
    const candidates = yield* projections.getLimitFailoverCandidates(
      switching.flatMap((group) => group.instanceIds),
    );
    const judged = yield* Ref.get(exhausted);
    const next = new Map<RunId, string>();
    const outcomes: Array<UsageLimitFailoverOutcome> = [];
    for (const candidate of candidates) {
      // The first group naming an account decides, as everywhere else.
      const group = providerFailoverGroupFor(
        preferences.failoverGroups,
        candidate.thread.modelSelection.instanceId,
      );
      if (group?.onUsageLimit !== "switch") continue;
      const signature = encodeGroup(group);
      if (judged.get(candidate.runId) === signature) {
        next.set(candidate.runId, signature);
        continue;
      }
      const outcome = yield* failover(candidate, group, preferences).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-failover.failed", {
            threadId: candidate.thread.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (outcome === null) continue;
      if (outcome.type === "exhausted") next.set(candidate.runId, signature);
      outcomes.push(outcome);
    }
    yield* Ref.set(exhausted, next);
    return outcomes;
  });

  return UsageLimitFailoverService.of({ sweep });
});

export const layer = Layer.effect(UsageLimitFailoverService, make);
