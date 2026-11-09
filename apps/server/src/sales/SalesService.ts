import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/unstable/http";
import type { SalesEngineSettings, SalesSnapshot, SalesStreamEvent } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as SalesEngineApi from "./SalesEngineApi.ts";

/** The engine suggests about a minute for `/summary`; nothing there changes faster. */
export const SALES_POLL_INTERVAL = "60 seconds";

const EMPTY_SNAPSHOT: SalesSnapshot = {
  status: "not-configured",
  message: null,
  summary: null,
  summaryReadAt: null,
  checkedAt: null,
};

const configKey = (config: SalesEngineSettings) => `${config.baseUrl}\n${config.readToken}`;
const isConfigured = (config: SalesEngineSettings) =>
  config.baseUrl.length > 0 && config.readToken.length > 0;

/**
 * Reads this environment's sales engine for the Sales area. Phoenix keeps no sales records:
 * the latest answer lives in memory and is streamed to subscribers. The engine is polled only
 * while at least one client is subscribed, by one poller however many subscribe, and reads
 * that overlap (a tick, a manual refresh, a settings change) share one request. Engine
 * failures are a status on the snapshot, never a failed stream.
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
  }
>()("t3/sales/SalesService") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<SalesSnapshot>(EMPTY_SNAPSHOT);
  /** The engine the snapshot's summary came from, so a new URL or token drops the old one. */
  const lastConfigKey = yield* Ref.make<string | null>(null);
  const inFlight = yield* SynchronizedRef.make(Option.none<Fiber.Fiber<SalesSnapshot>>());
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
      }).pipe(Effect.as({ baseUrl: "", readToken: "" })),
    ),
  );

  const publish = (snapshot: SalesSnapshot) => SubscriptionRef.setAndGet(state, snapshot);

  const readEngine = Effect.gen(function* () {
    const config = yield* readConfig;
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

    const result = yield* SalesEngineApi.readSummary(config).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.result,
    );
    if (Result.isSuccess(result)) {
      return yield* publish({
        status: "ready",
        message: null,
        summary: result.success,
        summaryReadAt: checkedAt,
        checkedAt,
      });
    }
    const error = result.failure;
    yield* Effect.logWarning("failed to read the sales engine", {
      status: error.status,
      httpStatus: error.httpStatus,
    });
    // Keep the last summary through an error so the screen can show it as stale.
    return yield* publish({
      status: error.status,
      message: error.message,
      summary: previous.summary,
      summaryReadAt: previous.summaryReadAt,
      checkedAt,
    });
  });

  // The read runs in the service scope, so a caller that goes away does not cancel it for the
  // others waiting on it.
  const refresh = Effect.gen(function* () {
    const fiber = yield* SynchronizedRef.modifyEffect(inFlight, (current) =>
      Option.match(current, {
        onSome: (fiber) => Effect.succeed([fiber, current] as const),
        onNone: () =>
          readEngine.pipe(
            Effect.ensuring(SynchronizedRef.set(inFlight, Option.none())),
            Effect.forkIn(serviceScope),
            Effect.map((fiber) => [fiber, Option.some(fiber)] as const),
          ),
      }),
    );
    return yield* Fiber.join(fiber);
  });

  const refreshOnSettingsChange = serverSettings.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Ref.get(lastConfigKey).pipe(
        Effect.flatMap((key) =>
          key === configKey(settings.salesEngine) ? Effect.void : refresh.pipe(Effect.asVoid),
        ),
      ),
    ),
  );
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
      : pollLoop.pipe(
          Effect.forkIn(serviceScope),
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

  return SalesService.of({
    getSnapshot: SubscriptionRef.get(state),
    refresh,
    subscribe,
  });
});

export const layer = Layer.effect(SalesService, make);
