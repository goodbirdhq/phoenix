import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";
import type {
  SalesActionError,
  SalesApproveInput,
  SalesApproveResult,
  SalesCardState,
  SalesConversationDetail,
  SalesConversationList,
  SalesDevice,
  SalesDeviceList,
  SalesDispatch,
  SalesEditInput,
  SalesEditResult,
  SalesEngineSettings,
  SalesEngineStatus,
  SalesEnrolDeviceInput,
  SalesQueueItemDetail,
  SalesSnapshot,
  SalesStreamEvent,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as SalesEngineApi from "./SalesEngineApi.ts";

/** The engine suggests about a minute for `/summary` and `/queue`; nothing there changes faster. */
export const SALES_POLL_INTERVAL = "60 seconds";

/** Dispatches the snapshot remembers. They live in memory only, so a restart forgets them. */
const DISPATCH_MEMORY = 50;

/** A snapshot without the dispatch list, which outlives engine reads and engine changes. */
type EngineSnapshot = Omit<SalesSnapshot, "dispatches">;

const EMPTY_SNAPSHOT: EngineSnapshot = {
  status: "not-configured",
  message: null,
  summary: null,
  queue: null,
  summaryReadAt: null,
  checkedAt: null,
};

const statusFor = (error: SalesActionError): SalesEngineStatus => {
  switch (error.reason) {
    case "api-off":
      return "off";
    case "unauthorised":
    case "unreachable":
    case "not-configured":
      return error.reason;
    default:
      return "failed";
  }
};

const configKey = (config: SalesEngineSettings) => `${config.baseUrl}\n${config.readToken}`;
const engineConfig = (config: SalesEngineSettings): SalesEngineApi.SalesEngineConfig => ({
  baseUrl: config.baseUrl,
  readToken: config.readToken,
  actionToken: config.actionToken,
});
const isConfigured = (config: SalesEngineSettings) =>
  config.baseUrl.length > 0 && config.readToken.length > 0;

/**
 * Reads this environment's sales engine for the Sales area and relays the actions a client
 * asks for. Phoenix keeps no sales records: the latest summary and queue live in memory and
 * are streamed to subscribers. The engine is polled only while at least one client is
 * subscribed, by one poller however many subscribe, and reads that overlap (a tick, a manual
 * refresh, a settings change) share one request. Engine failures are a status on the snapshot,
 * never a failed stream. Details are read on demand.
 *
 * Nothing here can approve a send. `approve` carries presses a client signed with a device key
 * this server never holds; the engine checks each signature against the device it enrolled.
 */
export class SalesService extends Context.Service<
  SalesService,
  {
    /** The latest snapshot, without asking the engine. */
    readonly getSnapshot: Effect.Effect<SalesSnapshot>;
    /** Asks the engine now (or joins a read already in flight) and returns the result. */
    readonly refresh: Effect.Effect<SalesSnapshot>;
    /** The current snapshot, then every change. Polls the engine while the scope is open. */
    readonly subscribe: Effect.Effect<Stream.Stream<SalesStreamEvent>, never, Scope.Scope>;
    readonly getQueueItem: (
      activityId: string,
    ) => Effect.Effect<SalesQueueItemDetail, SalesActionError>;
    readonly listConversations: Effect.Effect<SalesConversationList, SalesActionError>;
    readonly getConversation: (
      contactKey: string,
    ) => Effect.Effect<SalesConversationDetail, SalesActionError>;
    /** Relays presses signed on a device. Per-item results, in the items' order. */
    readonly approve: (
      input: SalesApproveInput,
    ) => Effect.Effect<SalesApproveResult, SalesActionError>;
    readonly unapprove: (activityId: string) => Effect.Effect<SalesCardState, SalesActionError>;
    readonly edit: (input: SalesEditInput) => Effect.Effect<SalesEditResult, SalesActionError>;
    readonly discard: (input: {
      readonly activityId: string;
      readonly expectedHash: string;
    }) => Effect.Effect<SalesCardState, SalesActionError>;
    readonly listDevices: Effect.Effect<SalesDeviceList, SalesActionError>;
    readonly enrolDevice: (
      input: SalesEnrolDeviceInput,
    ) => Effect.Effect<SalesDevice, SalesActionError>;
    readonly revokeDevice: (deviceId: string) => Effect.Effect<SalesDevice, SalesActionError>;
    /** Remembers a thread Sales started, so every client can link it from its card. */
    readonly recordDispatch: (dispatch: SalesDispatch) => Effect.Effect<void>;
  }
>()("t3/sales/SalesService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<SalesSnapshot>({ ...EMPTY_SNAPSHOT, dispatches: [] });
  /** The engine the snapshot's summary came from, so a new URL or token drops the old one. */
  const lastConfigKey = yield* Ref.make<string | null>(null);
  /** The read in flight and the engine it is reading, so a settings change can replace it. */
  const inFlight = yield* Ref.make(
    Option.none<{
      readonly fiber: Fiber.Fiber<SalesSnapshot>;
      readonly key: string;
      readonly token: object;
    }>(),
  );
  // Guards choosing or replacing the read. A read's own cleanup uses `inFlight` without it, so
  // waiting on an interrupted read here cannot deadlock.
  const readLock = yield* Semaphore.make(1);
  const poller = yield* SynchronizedRef.make({
    subscribers: 0,
    fiber: Option.none<Fiber.Fiber<void>>(),
  });

  const readConfig = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.salesEngine),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read the sales engine settings", {
        operation: error.operation,
      }).pipe(Effect.as({ baseUrl: "", readToken: "", actionToken: "", agentsProjectId: "" })),
    ),
  );

  /** Replaces what the engine said, keeping the dispatch list. */
  const publish = (snapshot: EngineSnapshot) =>
    SubscriptionRef.updateAndGet(state, (current) => ({
      ...snapshot,
      dispatches: current.dispatches,
    }));

  const readEngine = (config: SalesEngineSettings) =>
    Effect.gen(function* () {
      const key = configKey(config);
      const sameEngine = (yield* Ref.getAndSet(lastConfigKey, key)) === key;
      const previous = sameEngine ? yield* SubscriptionRef.get(state) : EMPTY_SNAPSHOT;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);

      if (!isConfigured(config)) {
        return yield* publish(EMPTY_SNAPSHOT);
      }
      if (SalesEngineApi.salesApiBaseUrl(config.baseUrl) === null) {
        return yield* publish({
          ...EMPTY_SNAPSHOT,
          status: "failed",
          message: "The sales engine URL must be an http or https URL.",
          checkedAt,
        });
      }
      if (!sameEngine) {
        yield* publish({ ...EMPTY_SNAPSHOT, status: "loading" });
      }

      const engine = engineConfig(config);
      const result = yield* Effect.all(
        [SalesEngineApi.readSummary(engine), SalesEngineApi.readQueue(engine)],
        { concurrency: 2 },
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.result);
      if (Result.isSuccess(result)) {
        const [summary, queue] = result.success;
        return yield* publish({
          status: "ready",
          message: null,
          summary,
          queue,
          summaryReadAt: checkedAt,
          checkedAt,
        });
      }
      const error = result.failure;
      yield* Effect.logWarning("failed to read the sales engine", { reason: error.reason });
      // Keep the last answer through an error so the screen can show it as stale.
      return yield* publish({
        status: statusFor(error),
        message: error.message,
        summary: previous.summary,
        queue: previous.queue,
        summaryReadAt: previous.summaryReadAt,
        checkedAt,
      });
    });

  // The read runs in the service scope, so a caller that goes away does not cancel it for the
  // others waiting on it. A read of a different engine (the settings changed while it ran) is
  // interrupted and replaced rather than joined, so the old engine's answer never lands as the
  // new one's.
  const refresh = Effect.gen(function* () {
    const config = yield* readConfig;
    const key = configKey(config);
    const fiber = yield* readLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(inFlight);
        if (Option.isSome(current) && current.value.key === key) {
          return current.value.fiber;
        }
        if (Option.isSome(current)) {
          yield* Fiber.interrupt(current.value.fiber);
        }
        const token = {};
        // The read waits until its entry is recorded, so it can never finish (and clear the
        // entry) before the entry exists.
        const recorded = yield* Deferred.make<void>();
        const next = yield* Deferred.await(recorded).pipe(
          Effect.andThen(readEngine(config)),
          // Clear only our own entry: a replaced read must not clear its replacement.
          Effect.ensuring(
            Ref.update(inFlight, (entry) =>
              Option.isSome(entry) && entry.value.token === token ? Option.none() : entry,
            ),
          ),
          Effect.forkIn(serviceScope),
        );
        yield* Ref.set(inFlight, Option.some({ fiber: next, key, token }));
        yield* Deferred.succeed(recorded, undefined);
        return next;
      }),
    );
    return yield* Fiber.join(fiber);
  });

  // While anyone is watching, a settings change reads the new engine at once.
  const refreshOnSettingsChange = serverSettings.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Ref.get(lastConfigKey).pipe(
        Effect.flatMap((key) =>
          key === configKey(settings.salesEngine) ? Effect.void : refresh.pipe(Effect.asVoid),
        ),
      ),
    ),
  );

  /**
   * The snapshot, unless the settings now name a different engine than the one it came from;
   * then it belongs to the old engine and is dropped, so nobody sees it under the new settings.
   */
  const currentSnapshot = Effect.gen(function* () {
    const key = configKey(yield* readConfig);
    const last = yield* Ref.get(lastConfigKey);
    if (last === null || last === key) return yield* SubscriptionRef.get(state);
    yield* Ref.set(lastConfigKey, null);
    return yield* publish(EMPTY_SNAPSHOT);
  });

  const pollLoop = Effect.all(
    [
      refresh.pipe(Effect.andThen(Effect.sleep(SALES_POLL_INTERVAL)), Effect.forever),
      refreshOnSettingsChange,
    ],
    { concurrency: "unbounded", discard: true },
  );

  const attach = SynchronizedRef.updateEffect(poller, (current) =>
    current.subscribers > 0
      ? Effect.succeed({ ...current, subscribers: current.subscribers + 1 })
      : currentSnapshot.pipe(
          Effect.andThen(pollLoop.pipe(Effect.forkIn(serviceScope))),
          Effect.map((fiber) => ({ subscribers: 1, fiber: Option.some(fiber) })),
        ),
  );
  const detach = SynchronizedRef.updateEffect(poller, (current) =>
    current.subscribers > 1
      ? Effect.succeed({ ...current, subscribers: current.subscribers - 1 })
      : Option.match(current.fiber, {
          onNone: () => Effect.void,
          onSome: Fiber.interrupt,
        }).pipe(Effect.as({ subscribers: 0, fiber: Option.none<Fiber.Fiber<void>>() })),
  );

  const subscribe = Effect.acquireRelease(attach, () => detach).pipe(
    Effect.as(
      SubscriptionRef.changes(state).pipe(
        Stream.map((snapshot): SalesStreamEvent => ({ type: "sales-snapshot", snapshot })),
      ),
    ),
  );

  /** Runs one engine call against the current settings. */
  const withEngine = <A>(
    call: (
      config: SalesEngineApi.SalesEngineConfig,
    ) => Effect.Effect<A, SalesActionError, HttpClient.HttpClient>,
  ) =>
    readConfig.pipe(
      Effect.flatMap((config) => call(engineConfig(config))),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  /**
   * After an action changed a card, read the queue again so every watching client sees it. In
   * the background, and only while someone watches: the caller already has the card's new state.
   */
  const refreshAfterAction = SynchronizedRef.get(poller).pipe(
    Effect.flatMap((current) =>
      current.subscribers > 0
        ? refresh.pipe(Effect.forkIn(serviceScope), Effect.asVoid)
        : Effect.void,
    ),
  );
  const changesCards = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.tap(() => refreshAfterAction));

  return SalesService.of({
    getSnapshot: currentSnapshot,
    refresh,
    subscribe,
    getQueueItem: (activityId) =>
      withEngine((config) => SalesEngineApi.readQueueItem(config, activityId)),
    listConversations: withEngine(SalesEngineApi.readConversations),
    getConversation: (contactKey) =>
      withEngine((config) => SalesEngineApi.readConversation(config, contactKey)),
    approve: (input) =>
      changesCards(
        withEngine((config) => SalesEngineApi.approve(config, input)).pipe(
          Effect.map((results) => ({ results })),
        ),
      ),
    unapprove: (activityId) =>
      changesCards(withEngine((config) => SalesEngineApi.unapprove(config, activityId))),
    edit: (input) => changesCards(withEngine((config) => SalesEngineApi.edit(config, input))),
    discard: (input) => changesCards(withEngine((config) => SalesEngineApi.discard(config, input))),
    listDevices: withEngine(SalesEngineApi.listDevices),
    enrolDevice: (input) => withEngine((config) => SalesEngineApi.enrolDevice(config, input)),
    revokeDevice: (deviceId) =>
      withEngine((config) => SalesEngineApi.revokeDevice(config, deviceId)),
    recordDispatch: (dispatch) =>
      SubscriptionRef.update(state, (current) => ({
        ...current,
        dispatches: [dispatch, ...current.dispatches].slice(0, DISPATCH_MEMORY),
      })),
  });
});

export const layer = Layer.effect(SalesService, make);
