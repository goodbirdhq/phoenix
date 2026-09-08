import type {
  EnvironmentId,
  AuthSessionId,
  AuthEnvironmentScope,
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ConnectionBlockedError, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily, createRuntimeCommand } from "./runtime.ts";

export type AuthAccessAction =
  | {
      readonly kind: "create";
      readonly label?: string;
      readonly scopes: readonly AuthEnvironmentScope[];
    }
  | { readonly kind: "revokeLink"; readonly id: string }
  | { readonly kind: "revokeClient"; readonly sessionId: AuthSessionId }
  | { readonly kind: "revokeOthers" };

/** Each mutation uses the selected environment's URL and current cookie, bearer or DPoP credential. */
export const executeAuthAccessAction = Effect.fn("auth.executeAccessAction")(function* (
  prepared: PreparedConnection,
  action: AuthAccessAction,
) {
  const path =
    action.kind === "create"
      ? "/api/auth/pairing-token"
      : action.kind === "revokeLink"
        ? "/api/auth/pairing-links/revoke"
        : action.kind === "revokeClient"
          ? "/api/auth/clients/revoke"
          : "/api/auth/clients/revoke-others";
  const url = environmentEndpointUrl(prepared.httpBaseUrl, path);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.httpAuthorization,
    "POST",
    url,
    signer,
  );
  const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
  switch (action.kind) {
    case "create":
      return yield* executeEnvironmentHttpRequest(
        url,
        10_000,
        withEnvironmentCredentials(
          prepared.httpAuthorization,
          client.auth.pairingCredential({
            headers,
            payload: { ...(action.label ? { label: action.label } : {}), scopes: action.scopes },
          }),
        ),
      );
    case "revokeLink":
      return yield* executeEnvironmentHttpRequest(
        url,
        10_000,
        withEnvironmentCredentials(
          prepared.httpAuthorization,
          client.auth.revokePairingLink({ headers, payload: { id: action.id } }),
        ),
      );
    case "revokeClient":
      return yield* executeEnvironmentHttpRequest(
        url,
        10_000,
        withEnvironmentCredentials(
          prepared.httpAuthorization,
          client.auth.revokeClient({ headers, payload: { sessionId: action.sessionId } }),
        ),
      );
    case "revokeOthers":
      return yield* executeEnvironmentHttpRequest(
        url,
        10_000,
        withEnvironmentCredentials(
          prepared.httpAuthorization,
          client.auth.revokeOtherClients({ headers }),
        ),
      );
  }
});

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

export function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    action: createRuntimeCommand(runtime, {
      label: "environment:auth-access-action",
      execute: ({
        environmentId,
        action,
      }: {
        environmentId: EnvironmentId;
        action: AuthAccessAction;
      }) =>
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return yield* registry.run(
            environmentId,
            Effect.gen(function* () {
              const supervisor = yield* EnvironmentSupervisor;
              const prepared = yield* SubscriptionRef.get(supervisor.prepared);
              if (Option.isNone(prepared))
                return yield* Effect.fail(
                  new ConnectionBlockedError({
                    reason: "configuration",
                    detail: "Reconnect this environment before managing access.",
                  }),
                );
              return yield* executeAuthAccessAction(prepared.value, action);
            }),
          );
        }),
    }),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
