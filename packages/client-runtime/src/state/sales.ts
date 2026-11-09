import {
  SALES_WS_METHODS,
  type EnvironmentId,
  type SalesSnapshot,
  type SalesStreamEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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

const makeEnvironmentSalesState = Effect.fn("EnvironmentSalesState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  const state = yield* SubscriptionRef.make<EnvironmentSalesState>({
    ...EMPTY_SALES_STATE,
    status: "synchronizing",
  });

  const applyEvent = (event: SalesStreamEvent) =>
    SubscriptionRef.set(state, {
      snapshot: Option.some(event.snapshot),
      status: "live",
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
  return {
    stateValueAtom,
    /** Asks the engine now. The new snapshot also arrives on the subscription. */
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sales:refresh",
      tag: SALES_WS_METHODS.refresh,
      scheduler: createAtomCommandScheduler(),
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}
