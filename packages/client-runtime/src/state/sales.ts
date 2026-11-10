import {
  SALES_WS_METHODS,
  type EnvironmentId,
  type SalesSnapshot,
  type SalesStreamEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
} from "./runtime.ts";

/**
 * - `empty`: nothing received from this environment yet.
 * - `synchronizing`: connecting or resubscribing; the snapshot, if any, is the last one seen.
 * - `live`: the snapshot is the server's current one.
 * - `cached`: disconnected; the snapshot is the last one seen in this session.
 */
export type EnvironmentSalesStatus = "empty" | "synchronizing" | "live" | "cached";

/**
 * One environment's Sales state. Phoenix keeps no sales records, so the snapshot lives only in
 * memory: the server's live answer wins, and the last one seen bridges a reconnect.
 */
export interface EnvironmentSalesState {
  readonly snapshot: Option.Option<SalesSnapshot>;
  readonly status: EnvironmentSalesStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SALES_STATE: EnvironmentSalesState = Object.freeze({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
});

const settledStatus = (snapshot: Option.Option<SalesSnapshot>): EnvironmentSalesStatus =>
  Option.isSome(snapshot) ? "cached" : "empty";

/**
 * Whether an environment's server can read a sales engine and its settings name one. The
 * Sales area is hidden for an environment unless this holds; the token is a redaction marker
 * on the client, so only its presence counts.
 */
export function isSalesConfigured(config: ServerConfig | null | undefined): boolean {
  if (config?.environment.capabilities.sales !== true) return false;
  const engine = config.settings.salesEngine;
  return engine.baseUrl.length > 0 && engine.readToken.length > 0;
}

/** Whether the environment's server holds an action token, so drafts can be acted on. */
export function canActOnSales(config: ServerConfig | null | undefined): boolean {
  return isSalesConfigured(config) && (config?.settings.salesEngine.actionToken.length ?? 0) > 0;
}

/**
 * The snapshot after a read that found nothing new (`sales-read`). The engine's summary is as of
 * the previous summary read, so what it measured at that moment moves on by the time between the
 * two reads: its `generatedAt` and the dispatcher ages. Everything else stands.
 */
export function applySalesRead(
  snapshot: SalesSnapshot,
  read: Extract<SalesStreamEvent, { readonly type: "sales-read" }>,
): SalesSnapshot {
  const elapsedMs =
    snapshot.summaryReadAt === null || read.summaryReadAt === null
      ? 0
      : Math.max(0, Date.parse(read.summaryReadAt) - Date.parse(snapshot.summaryReadAt));
  const summary = snapshot.summary;
  const generatedAt = summary === null ? Number.NaN : Date.parse(summary.generatedAt);
  const older = (age: number | null) => (age === null ? null : age + Math.round(elapsedMs / 1000));
  return {
    ...snapshot,
    summaryReadAt: read.summaryReadAt,
    checkedAt: read.checkedAt,
    summary:
      summary === null
        ? null
        : {
            ...summary,
            generatedAt: Number.isNaN(generatedAt)
              ? summary.generatedAt
              : DateTime.formatIso(DateTime.makeUnsafe(generatedAt + elapsedMs)),
            dispatcher: {
              ...summary.dispatcher,
              pokeAgeSeconds: older(summary.dispatcher.pokeAgeSeconds),
              tickAgeSeconds: older(summary.dispatcher.tickAgeSeconds),
            },
          },
  };
}

const makeEnvironmentSalesState = Effect.fn("EnvironmentSalesState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  const state = yield* SubscriptionRef.make<EnvironmentSalesState>({
    ...EMPTY_SALES_STATE,
    status: "synchronizing",
  });

  const applyEvent = (event: SalesStreamEvent) =>
    SubscriptionRef.update(state, (current) => ({
      snapshot:
        event.type === "sales-snapshot"
          ? Option.some(event.snapshot)
          : Option.map(current.snapshot, (snapshot) => applySalesRead(snapshot, event)),
      status: "live" as const,
      error: Option.none(),
    }));

  const subscribeSupportedSession = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.switchMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (session) =>
          Stream.unwrap(
            session.initialConfig.pipe(
              Effect.map((config) =>
                config.environment.capabilities.sales === true
                  ? subscribeDynamic(SALES_WS_METHODS.subscribe, () => Effect.succeed({}), {
                      onExpectedFailure: (cause) =>
                        SubscriptionRef.update(state, (current) => ({
                          ...current,
                          status: settledStatus(current.snapshot),
                          error: Option.some("Could not synchronize Sales."),
                        })).pipe(
                          Effect.andThen(Effect.logWarning("Could not synchronize Sales.")),
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
                        status: settledStatus(current.snapshot),
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
            status: settledStatus(current.snapshot),
          }));
        case "ready":
          return Effect.void;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

function salesStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentSalesState().pipe(Effect.map((state) => SubscriptionRef.changes(state))),
    ),
  );
}

/**
 * Sales atoms per environment. Reading `stateValueAtom` subscribes the environment's server,
 * which polls its engine only while some client is subscribed; unmount to let it stop.
 */
export function createSalesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(salesStateChanges(environmentId), { initialValue: EMPTY_SALES_STATE }),
  );
  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SALES_STATE),
    ).pipe(Atom.withLabel(`environment-sales-value:${environmentId}`)),
  );
  const scheduler = createAtomCommandScheduler();
  const parallel = { mode: "parallel" } as const;
  /** Actions on one card run one at a time, so an edit and an approve never cross. */
  const perCard = {
    mode: "serial",
    key: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { activityId: string };
    }) => `${environmentId}:${input.activityId}`,
  } as const;
  return {
    stateValueAtom,
    /** Asks the engine now. The new snapshot also arrives on the subscription. */
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:refresh",
      tag: SALES_WS_METHODS.refresh,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    // Reads on demand. Never cached: a card is signed only as just read.
    getQueueItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:queue-item",
      tag: SALES_WS_METHODS.getQueueItem,
      scheduler,
      concurrency: parallel,
    }),
    listConversations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:conversations",
      tag: SALES_WS_METHODS.listConversations,
      scheduler,
      concurrency: parallel,
    }),
    getConversation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:conversation",
      tag: SALES_WS_METHODS.getConversation,
      scheduler,
      concurrency: parallel,
    }),
    listDevices: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:devices",
      tag: SALES_WS_METHODS.listDevices,
      scheduler,
      concurrency: parallel,
    }),
    /** Carries presses this client signed. The server cannot sign. */
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:approve",
      tag: SALES_WS_METHODS.approve,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    unapprove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:unapprove",
      tag: SALES_WS_METHODS.unapprove,
      scheduler,
      concurrency: perCard,
    }),
    edit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:edit",
      tag: SALES_WS_METHODS.edit,
      scheduler,
      concurrency: perCard,
    }),
    discard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:discard",
      tag: SALES_WS_METHODS.discard,
      scheduler,
      concurrency: perCard,
    }),
    enrolDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:enrol-device",
      tag: SALES_WS_METHODS.enrolDevice,
      scheduler,
      concurrency: parallel,
    }),
    revokeDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:revoke-device",
      tag: SALES_WS_METHODS.revokeDevice,
      scheduler,
      concurrency: parallel,
    }),
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:dispatch",
      tag: SALES_WS_METHODS.dispatch,
      scheduler,
      concurrency: parallel,
    }),
  };
}
