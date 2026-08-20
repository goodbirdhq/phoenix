import {
  SCHEDULE_WS_METHODS,
  type EnvironmentId,
  type ScheduleListSnapshot,
  type ScheduleListStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { request, subscribeDynamic } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
  runInEnvironment,
} from "./runtime.ts";

export type EnvironmentScheduleStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentScheduleState {
  readonly snapshot: Option.Option<ScheduleListSnapshot>;
  readonly status: EnvironmentScheduleStatus;
  readonly error: Option.Option<string>;
}

export interface ScheduleDetailQueryInput {
  readonly scheduleId: import("@t3tools/contracts").ScheduleId;
  /** Busts the detail atom when a newer environment Schedule projection is observed. */
  readonly revision?: number;
}

type ScheduleDetailCache = Pick<
  EnvironmentCacheStore["Service"],
  "loadScheduleDetail" | "saveScheduleDetail"
>;

const scheduleDetailPersistenceLock = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });
const deletedScheduleRevision = new Map<string, number>();

function scheduleDetailPersistenceKey(environmentId: EnvironmentId, scheduleId: string): string {
  return `${environmentId}:${scheduleId}`;
}

export const persistScheduleDetailIfNewer = Effect.fn(
  "EnvironmentScheduleState.persistDetailIfNewer",
)(function* (
  cache: ScheduleDetailCache,
  environmentId: EnvironmentId,
  detail: import("@t3tools/contracts").ScheduleDetail,
) {
  if (!cache.loadScheduleDetail || !cache.saveScheduleDetail) return;
  const key = scheduleDetailPersistenceKey(environmentId, detail.id);
  yield* scheduleDetailPersistenceLock.withPermit(key)(
    Effect.gen(function* () {
      const deletedAtRevision = deletedScheduleRevision.get(key);
      if (deletedAtRevision !== undefined && deletedAtRevision >= detail.revision) return;
      const persisted = yield* cache.loadScheduleDetail!(environmentId, detail.id);
      if (Option.isSome(persisted) && persisted.value.revision > detail.revision) return;
      yield* cache.saveScheduleDetail!(environmentId, detail);
      if (deletedAtRevision !== undefined) deletedScheduleRevision.delete(key);
    }),
  );
});

export const removePersistedScheduleDetail = Effect.fn(
  "EnvironmentScheduleState.removePersistedDetail",
)(function* (
  cache: Pick<EnvironmentCacheStore["Service"], "loadScheduleDetail" | "removeScheduleDetail">,
  environmentId: EnvironmentId,
  scheduleId: import("@t3tools/contracts").ScheduleId,
  revision: number,
) {
  const key = scheduleDetailPersistenceKey(environmentId, scheduleId);
  yield* scheduleDetailPersistenceLock.withPermit(key)(
    Effect.gen(function* () {
      const deletionRevision = Math.max(deletedScheduleRevision.get(key) ?? 0, revision);
      const persisted = cache.loadScheduleDetail
        ? yield* cache.loadScheduleDetail(environmentId, scheduleId)
        : Option.none();
      if (Option.isSome(persisted) && persisted.value.revision > deletionRevision) {
        deletedScheduleRevision.delete(key);
        return;
      }
      deletedScheduleRevision.set(key, deletionRevision);
      if (cache.removeScheduleDetail) yield* cache.removeScheduleDetail(environmentId, scheduleId);
    }),
  );
});

const EMPTY_SCHEDULE_STATE: EnvironmentScheduleState = Object.freeze({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
});

function cachedStatus(snapshot: Option.Option<ScheduleListSnapshot>): EnvironmentScheduleStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

export function applyScheduleListEvent(
  current: ScheduleListSnapshot,
  event: ScheduleListStreamEvent,
): ScheduleListSnapshot {
  if (event.type === "schedule-list-reset") return event.snapshot;
  if (event.sequence <= current.sequence) return current;

  if (event.type === "schedule-removed") {
    return {
      ...current,
      sequence: event.sequence,
      schedules: current.schedules.filter((schedule) => schedule.id !== event.scheduleId),
    };
  }

  const index = current.schedules.findIndex((schedule) => schedule.id === event.schedule.id);
  const schedules = [...current.schedules];
  if (index === -1) schedules.push(event.schedule);
  else schedules[index] = event.schedule;
  return {
    sequence: event.sequence,
    schedules,
    updatedAt: event.schedule.updatedAt,
  };
}

const makeEnvironmentScheduleState = Effect.fn("EnvironmentScheduleState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = cache.loadScheduleSnapshot
    ? yield* cache
        .loadScheduleSnapshot(environmentId)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached Schedules.").pipe(
              Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
              Effect.as(Option.none<ScheduleListSnapshot>()),
            ),
          ),
        )
    : Option.none<ScheduleListSnapshot>();
  const state = yield* SubscriptionRef.make<EnvironmentScheduleState>({
    snapshot: cachedSnapshot,
    status: cachedStatus(cachedSnapshot),
    error: Option.none(),
  });
  const persistence = yield* Queue.sliding<ScheduleListSnapshot>(1);

  if (cache.saveScheduleSnapshot) {
    yield* Stream.fromQueue(persistence).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach((snapshot) =>
        cache.saveScheduleSnapshot!(environmentId, snapshot).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not persist the Schedule cache.").pipe(
              Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }

  const applyEvent = Effect.fn("EnvironmentScheduleState.applyEvent")(function* (
    event: ScheduleListStreamEvent,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const previousSnapshot = Option.getOrNull(current.snapshot);
    const nextSnapshot =
      event.type === "schedule-list-reset"
        ? event.snapshot
        : Option.match(current.snapshot, {
            onNone: () => null,
            onSome: (snapshot) => applyScheduleListEvent(snapshot, event),
          });
    if (nextSnapshot === null) return;
    const removedScheduleIds =
      event.type === "schedule-list-reset"
        ? (previousSnapshot?.schedules ?? [])
            .filter(
              (previous) =>
                !event.snapshot.schedules.some((schedule) => schedule.id === previous.id),
            )
            .map((schedule) => schedule.id)
        : event.type === "schedule-removed" && nextSnapshot !== previousSnapshot
          ? [event.scheduleId]
          : [];
    yield* Effect.forEach(
      removedScheduleIds,
      (scheduleId) =>
        removePersistedScheduleDetail(cache, environmentId, scheduleId, nextSnapshot.sequence).pipe(
          Effect.ignore,
        ),
      { discard: true },
    );
    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(nextSnapshot),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, nextSnapshot);
  });

  yield* SubscriptionRef.set(state, {
    snapshot: cachedSnapshot,
    status: "synchronizing",
    error: Option.none(),
  });
  const subscribeSupportedSession = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.switchMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (session) =>
          Stream.unwrap(
            session.initialConfig.pipe(
              Effect.map((config) =>
                config.environment.capabilities.schedules === true
                  ? subscribeDynamic(SCHEDULE_WS_METHODS.subscribe, () => Effect.succeed({}), {
                      onExpectedFailure: (cause) =>
                        SubscriptionRef.update(state, (current) => ({
                          ...current,
                          status: cachedStatus(current.snapshot),
                          error: Option.some("Could not synchronize Schedules."),
                        })).pipe(
                          Effect.andThen(Effect.logWarning("Could not synchronize Schedules.")),
                          Effect.annotateLogs({
                            environmentId,
                            ...safeErrorLogAttributes(Cause.squash(cause)),
                          }),
                        ),
                      retryExpectedFailureAfter: "250 millis",
                    })
                  : Stream.fromEffect(
                      SubscriptionRef.update(state, (current) => ({
                        ...current,
                        status: cachedStatus(current.snapshot),
                      })),
                    ).pipe(Stream.drain),
              ),
              Effect.orElseSucceed(() => Stream.empty),
            ),
          ),
      }),
    ),
  );
  yield* subscribeSupportedSession.pipe(Stream.runForEach(applyEvent), Effect.forkScoped);

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return SubscriptionRef.update(state, (current) => ({
            ...current,
            status: "synchronizing" as const,
          }));
        case "disconnected":
          return SubscriptionRef.update(state, (current) => ({
            ...current,
            status: cachedStatus(current.snapshot),
          }));
        case "ready":
          return Effect.void;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

function scheduleStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentScheduleState().pipe(Effect.map((state) => SubscriptionRef.changes(state))),
    ),
  );
}

export function createScheduleEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(scheduleStateChanges(environmentId), {
      initialValue: EMPTY_SCHEDULE_STATE,
    }),
  );
  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(stateAtom(environmentId))),
        () => EMPTY_SCHEDULE_STATE,
      ),
    ).pipe(Atom.withLabel(`environment-schedules-value:${environmentId}`)),
  );
  const detailRefreshStateAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(stateValueAtom(environmentId)).status).pipe(
      Atom.withLabel(`environment-schedules-detail-refresh:${environmentId}`),
    ),
  );
  const serialPerSchedule = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { scheduleId: string } }) =>
      JSON.stringify([environmentId, input.scheduleId]),
  };
  const detailFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ScheduleDetailQueryInput];
    return runtime
      .atom((get) => {
        get(detailRefreshStateAtom(environmentId));
        return runInEnvironment(
          environmentId,
          Effect.gen(function* () {
            const cache = yield* EnvironmentCacheStore;
            const supervisor = yield* EnvironmentSupervisor;
            const cached = cache.loadScheduleDetail
              ? yield* cache
                  .loadScheduleDetail(supervisor.target.environmentId, input.scheduleId)
                  .pipe(Effect.orElseSucceed(() => Option.none()))
              : Option.none();
            return yield* request(SCHEDULE_WS_METHODS.getDetail, {
              scheduleId: input.scheduleId,
            }).pipe(
              Effect.tap((value) =>
                persistScheduleDetailIfNewer(cache, supervisor.target.environmentId, value).pipe(
                  Effect.ignore,
                ),
              ),
              Effect.catch((error) =>
                Option.isSome(cached) ? Effect.succeed(cached.value) : Effect.fail(error),
              ),
            );
          }),
        );
      })
      .pipe(
        Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:schedules:detail:${key}`),
      );
  });
  const detail = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ScheduleDetailQueryInput;
  }) => detailFamily(environmentRpcKey(target));

  return {
    /** Cached/live environment-owned Schedule projection. */
    list: stateAtom,
    stateAtom,
    stateValueAtom,
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:schedules:snapshot",
      tag: SCHEDULE_WS_METHODS.getSnapshot,
      staleTimeMs: 5_000,
    }),
    detail,
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:schedules:history",
      tag: SCHEDULE_WS_METHODS.getHistory,
      staleTimeMs: 30_000,
    }),
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:schedules:dispatch",
      tag: SCHEDULE_WS_METHODS.dispatchCommand,
      scheduler,
      concurrency: serialPerSchedule,
      onSuccess: ({ environmentId, input }, _registry, result) =>
        input.type === "schedule.delete"
          ? EnvironmentCacheStore.pipe(
              Effect.flatMap((cache) =>
                removePersistedScheduleDetail(
                  cache,
                  environmentId,
                  input.scheduleId,
                  result.sequence,
                ),
              ),
              Effect.ignore,
            )
          : Effect.void,
    }),
  };
}
