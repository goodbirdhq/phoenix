import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
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
  SalesHoldResult,
  SalesQueue,
  SalesQueueItemDetail,
  SalesResumeInput,
  SalesResumeResult,
  SalesSnapshot,
  SalesStreamEvent,
  SalesSummary,
  SalesTaskReport,
  SalesTaskReportInput,
  SalesView,
  SalesViewName,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, salesEngineRoot } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as PolledRead from "./PolledRead.ts";
import * as SalesEngineApi from "./SalesEngineApi.ts";

/** The engine suggests about a minute for `/summary` and `/queue`; nothing there changes faster. */
export const SALES_POLL_INTERVAL = "60 seconds";
/** Campaign figures move with sends and replies over days; a minute's precision buys nothing. */
const CAMPAIGNS_POLL_INTERVAL = "5 minutes";

/**
 * The latest read of one engine list. `data` is kept through later errors, so beside a non-ready
 * status it is stale; `readAt` is when it was read and `checkedAt` when the engine was last asked.
 */
interface EngineRead<A> {
  readonly status: SalesEngineStatus;
  readonly message: string | null;
  readonly data: A | null;
  readonly readAt: string | null;
  readonly checkedAt: string | null;
}

const UNREAD: EngineRead<never> = {
  status: "loading",
  message: null,
  data: null,
  readAt: null,
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
 * `resume` gives back only what no person approved: a route chase someone paused.
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
    /** One area's engine list now, then every change. Polls that list while the scope is open. */
    readonly subscribeView: (
      view: SalesViewName,
    ) => Effect.Effect<Stream.Stream<SalesView>, never, Scope.Scope>;
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
    /**
     * Pauses a chase the route approved, or takes a person's approval back (`result` says which).
     * A send already claimed is not stopped: see `card.sendStatus`.
     */
    readonly hold: (activityId: string) => Effect.Effect<SalesHoldResult, SalesActionError>;
    /** Gives a paused route chase back to the route, for the version the person saw. */
    readonly resume: (
      input: SalesResumeInput,
    ) => Effect.Effect<SalesResumeResult, SalesActionError>;
    readonly edit: (input: SalesEditInput) => Effect.Effect<SalesEditResult, SalesActionError>;
    readonly discard: (input: {
      readonly activityId: string;
      readonly expectedHash: string;
    }) => Effect.Effect<SalesCardState, SalesActionError>;
    /** Reports what the person did about a LinkedIn task, as a press on its card would. */
    readonly reportTask: (
      input: SalesTaskReportInput,
    ) => Effect.Effect<SalesTaskReport, SalesActionError>;
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

/** A view read with what moves on every read blanked: our read times and the engine's. */
const viewWithoutReadTimes = <A extends { readonly generatedAt: string }>(read: EngineRead<A>) => ({
  ...read,
  readAt: null,
  checkedAt: null,
  data: read.data === null ? null : { ...read.data, generatedAt: "" },
});

/** What a view sends for each name: that view's engine list. */
type ViewData<View extends SalesViewName> = NonNullable<
  Extract<SalesView, { readonly view: View }>["data"]
>;

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const readConfig = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.salesEngine),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read the sales engine settings", {
        operation: error.operation,
      }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS.salesEngine)),
    ),
  );

  /**
   * One engine list, read for whoever watches it: polled only while someone does, the last
   * answer kept beside a later error, and dropped once the settings name another engine. A URL or
   * token change while watched reads the new engine at once.
   */
  const engineList = <A>(options: {
    /** For the logs. */
    readonly name: string;
    readonly read: (
      config: SalesEngineApi.SalesEngineConfig,
    ) => Effect.Effect<A, SalesActionError, HttpClient.HttpClient>;
    readonly interval: Duration.Input;
  }) =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<EngineRead<A>>(UNREAD);
      /** The engine `state` came from. */
      const lastConfigKey = yield* Ref.make<string | null>(null);
      const publish = (read: EngineRead<A>) => SubscriptionRef.setAndGet(state, read);

      const readEngine = (config: SalesEngineSettings) =>
        Effect.gen(function* () {
          const key = configKey(config);
          const sameEngine = (yield* Ref.getAndSet(lastConfigKey, key)) === key;
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          if (!isConfigured(config)) {
            return yield* publish({ ...UNREAD, status: "not-configured" });
          }
          if (salesEngineRoot(config.baseUrl) === null) {
            return yield* publish({
              ...UNREAD,
              status: "failed",
              message: "The sales engine URL must be an http or https URL.",
              checkedAt,
            });
          }
          if (!sameEngine) yield* publish(UNREAD);

          const result = yield* options
            .read(engineConfig(config))
            .pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.result);
          if (Result.isSuccess(result)) {
            return yield* publish({
              status: "ready",
              message: null,
              data: result.success,
              readAt: checkedAt,
              checkedAt,
            });
          }
          const error = result.failure;
          yield* Effect.logWarning("failed to read the sales engine", {
            list: options.name,
            reason: error.reason,
          });
          return yield* SubscriptionRef.updateAndGet(state, (previous) => ({
            ...previous,
            status: statusFor(error),
            message: error.message,
            checkedAt,
          }));
        });

      const polled = yield* PolledRead.make({
        input: readConfig,
        key: configKey,
        read: readEngine,
        interval: options.interval,
        // PolledRead only joins a read still in flight, so this filter is what skips a change
        // that leaves the engine as last read (any other setting), which would read it again.
        refreshWhen: serverSettings.streamChanges.pipe(
          Stream.filterEffect((settings) =>
            Ref.get(lastConfigKey).pipe(
              Effect.map((key) => key !== configKey(settings.salesEngine)),
            ),
          ),
        ),
      });

      /** The latest read, unless the settings now name another engine: then it is dropped. */
      const current = Effect.gen(function* () {
        const key = configKey(yield* readConfig);
        const last = yield* Ref.get(lastConfigKey);
        if (last === null || last === key) return yield* SubscriptionRef.get(state);
        yield* Ref.set(lastConfigKey, null);
        return yield* publish(UNREAD);
      });

      return {
        current,
        refresh: polled.refresh,
        refreshIfWatched: polled.refreshIfWatched,
        /**
         * Polls while the scope is open, and every read from now on, starting with the current
         * one. The old engine's read is dropped first, since the stream starts with it.
         */
        watch: current.pipe(
          Effect.andThen(polled.watch),
          Effect.as(SubscriptionRef.changes(state)),
        ),
      };
    });

  const snapshotList = yield* engineList({
    name: "summary",
    read: (engine) =>
      Effect.all(
        { summary: SalesEngineApi.readSummary(engine), queue: SalesEngineApi.readQueue(engine) },
        { concurrency: 2 },
      ),
    interval: SALES_POLL_INTERVAL,
  });
  const toSnapshot = (
    read: EngineRead<{ readonly summary: SalesSummary; readonly queue: SalesQueue }>,
  ): SalesSnapshot => ({
    status: read.status,
    message: read.message,
    summary: read.data?.summary ?? null,
    queue: read.data?.queue ?? null,
    summaryReadAt: read.readAt,
    checkedAt: read.checkedAt,
  });

  /**
   * One area's list, sent to a watcher only when a read says something new. A failed read
   * changes the status, so it is sent at once with `readAt` the last read that succeeded.
   */
  const makeView = <View extends SalesViewName>(
    view: View,
    read: (
      config: SalesEngineApi.SalesEngineConfig,
    ) => Effect.Effect<ViewData<View>, SalesActionError, HttpClient.HttpClient>,
    interval: Duration.Input = SALES_POLL_INTERVAL,
  ) =>
    engineList({ name: view, read, interval }).pipe(
      Effect.map((list) => ({
        refreshIfWatched: list.refreshIfWatched,
        watch: list.watch.pipe(
          Effect.map((reads) =>
            reads.pipe(
              Stream.changesWith((a, b) =>
                Equal.equals(viewWithoutReadTimes(a), viewWithoutReadTimes(b)),
              ),
              // The union cannot narrow on a generic `view`; `read` above ties data to it.
              Stream.map(
                ({ status, message, data, readAt }) =>
                  ({ view, status, message, data, readAt }) as SalesView,
              ),
            ),
          ),
        ),
      })),
    );

  const views: Record<
    SalesViewName,
    {
      readonly watch: Effect.Effect<Stream.Stream<SalesView>, never, Scope.Scope>;
      readonly refreshIfWatched: Effect.Effect<void>;
    }
  > = {
    autopilot: yield* makeView("autopilot", SalesEngineApi.readAutopilotToday),
    tasks: yield* makeView("tasks", SalesEngineApi.readTasks),
    campaigns: yield* makeView("campaigns", SalesEngineApi.readCampaigns, CAMPAIGNS_POLL_INTERVAL),
    mailboxes: yield* makeView("mailboxes", SalesEngineApi.readMailboxes),
    health: yield* makeView("health", SalesEngineApi.readHealth),
  };

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
   * After an action changed what the engine lists, read those lists again so every watching
   * client sees it. In the background, and only while someone watches: the caller already has
   * the action's answer.
   */
  const rereads =
    (...lists: ReadonlyArray<{ readonly refreshIfWatched: Effect.Effect<void> }>) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.tap(() => Effect.forEach(lists, (list) => list.refreshIfWatched)));
  const changesCards = rereads(snapshotList);
  /** Hold and Resume move a send on today's Autopilot too. */
  const changesSends = rereads(snapshotList, views.autopilot);
  /** A report closes a task, spends budget, and moves the summary's LinkedIn counts. */
  const changesTasks = rereads(snapshotList, views.tasks);

  return SalesService.of({
    getSnapshot: snapshotList.current.pipe(Effect.map(toSnapshot)),
    refresh: snapshotList.refresh.pipe(Effect.map(toSnapshot)),
    subscribe: snapshotList.watch.pipe(
      Effect.map((reads) => reads.pipe(Stream.map(toSnapshot), salesStreamEvents)),
    ),
    subscribeView: (view) => views[view].watch,
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
    hold: (activityId) =>
      changesSends(withEngine((config) => SalesEngineApi.hold(config, activityId))),
    resume: (input) => changesSends(withEngine((config) => SalesEngineApi.resume(config, input))),
    edit: (input) => changesCards(withEngine((config) => SalesEngineApi.edit(config, input))),
    discard: (input) => changesCards(withEngine((config) => SalesEngineApi.discard(config, input))),
    reportTask: (input) =>
      changesTasks(withEngine((config) => SalesEngineApi.reportTask(config, input))),
    listDevices: withEngine(SalesEngineApi.listDevices),
    enrolDevice: (input) => withEngine((config) => SalesEngineApi.enrolDevice(config, input)),
    revokeDevice: (deviceId) =>
      withEngine((config) => SalesEngineApi.revokeDevice(config, deviceId)),
  });
});

export const layer = Layer.effect(SalesService, make);
