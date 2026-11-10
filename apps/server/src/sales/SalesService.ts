import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
  SalesEditInput,
  SalesEditResult,
  SalesEngineSettings,
  SalesEngineStatus,
  SalesEnrolDeviceInput,
  SalesQueueItemDetail,
  SalesSnapshot,
  SalesStreamEvent,
} from "@t3tools/contracts";
import { salesEngineRoot } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as PolledRead from "./PolledRead.ts";
import * as SalesEngineApi from "./SalesEngineApi.ts";

/** The engine suggests about a minute for `/summary` and `/queue`; nothing there changes faster. */
export const SALES_POLL_INTERVAL = "60 seconds";

const EMPTY_SNAPSHOT: SalesSnapshot = {
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
  }
>()("t3/sales/SalesService") {}

/**
 * The snapshot with everything that changes on every read blanked: our read times, the engine's
 * `generatedAt`, and the dispatcher ages it measures from `generatedAt`.
 */
const withoutReadTimes = (snapshot: SalesSnapshot) => ({
  ...snapshot,
  summaryReadAt: null,
  checkedAt: null,
  summary:
    snapshot.summary === null
      ? null
      : {
          ...snapshot.summary,
          generatedAt: "",
          dispatcher: {
            ...snapshot.summary.dispatcher,
            pokeAgeSeconds: null,
            tickAgeSeconds: null,
          },
        },
  queue: snapshot.queue === null ? null : { ...snapshot.queue, generatedAt: "" },
});

/**
 * What subscribers are sent as the snapshot changes. A snapshot goes out only when it says
 * something new; a read that found nothing new sends just its read times (`sales-read`), so
 * "Updated" keeps meaning the last read without resending the whole snapshot every poll.
 */
const salesStreamEvents = (snapshots: Stream.Stream<SalesSnapshot>) =>
  snapshots.pipe(
    Stream.mapAccum(
      (): SalesSnapshot | null => null,
      (sent, next): readonly [SalesSnapshot | null, ReadonlyArray<SalesStreamEvent>] => {
        if (sent === null || !Equal.equals(withoutReadTimes(sent), withoutReadTimes(next))) {
          return [next, [{ type: "sales-snapshot", snapshot: next }]];
        }
        if (sent.checkedAt === next.checkedAt && sent.summaryReadAt === next.summaryReadAt) {
          return [sent, []];
        }
        return [
          next,
          [{ type: "sales-read", summaryReadAt: next.summaryReadAt, checkedAt: next.checkedAt }],
        ];
      },
    ),
  );

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* SubscriptionRef.make<SalesSnapshot>(EMPTY_SNAPSHOT);
  /** The engine the snapshot's summary came from, so a new URL or token drops the old one. */
  const lastConfigKey = yield* Ref.make<string | null>(null);
  const readConfig = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.salesEngine),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read the sales engine settings", {
        operation: error.operation,
      }).pipe(Effect.as({ baseUrl: "", readToken: "", actionToken: "", agentsProjectId: "" })),
    ),
  );

  const publish = (snapshot: SalesSnapshot) =>
    SubscriptionRef.set(state, snapshot).pipe(Effect.as(snapshot));

  const readEngine = (config: SalesEngineSettings) =>
    Effect.gen(function* () {
      const key = configKey(config);
      const sameEngine = (yield* Ref.getAndSet(lastConfigKey, key)) === key;
      const previous = sameEngine ? yield* SubscriptionRef.get(state) : EMPTY_SNAPSHOT;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);

      if (!isConfigured(config)) {
        return yield* publish(EMPTY_SNAPSHOT);
      }
      if (salesEngineRoot(config.baseUrl) === null) {
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

  const engineRead = yield* PolledRead.make({
    input: readConfig,
    key: configKey,
    read: readEngine,
    interval: SALES_POLL_INTERVAL,
    // While anyone is watching, a settings change reads the new engine at once. PolledRead only
    // joins a read still in flight, so this filter is what skips a change that leaves the engine
    // as last read (any other setting), which would otherwise read the engine again.
    refreshWhen: serverSettings.streamChanges.pipe(
      Stream.filterEffect((settings) =>
        Ref.get(lastConfigKey).pipe(Effect.map((key) => key !== configKey(settings.salesEngine))),
      ),
    ),
  });

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

  // A new subscriber first drops a snapshot from an engine the settings no longer name, since
  // the stream starts with the current snapshot.
  const subscribe = currentSnapshot.pipe(
    Effect.andThen(engineRead.watch),
    Effect.as(SubscriptionRef.changes(state).pipe(salesStreamEvents)),
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
  const changesCards = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.tap(() => engineRead.refreshIfWatched));

  return SalesService.of({
    getSnapshot: currentSnapshot,
    refresh: engineRead.refresh,
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
  });
});

export const layer = Layer.effect(SalesService, make);
