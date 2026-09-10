import type { NetworkStatus, SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type SessionRefreshResult =
  | { readonly status: "pending" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

export function evaluateSessionRefresh(input: {
  readonly networkStatus: NetworkStatus;
  readonly initialConnection: SupervisorConnectionState;
  readonly state: SupervisorConnectionState;
  readonly initialSnapshot: OrchestrationShellSnapshot | null;
  readonly shell: EnvironmentShellState;
}): SessionRefreshResult {
  if (input.networkStatus === "offline") {
    return { status: "error", message: "You are offline. Reconnect to refresh your sessions." };
  }
  const { state, initialConnection, shell, initialSnapshot } = input;
  if (state === initialConnection) return { status: "pending" };
  if (state.phase === "blocked" || state.phase === "backoff") {
    return { status: "error", message: "Could not reach an environment. Pull down to try again." };
  }
  if (state.phase !== "connected") return { status: "pending" };
  if (Option.isSome(shell.error)) return { status: "error", message: shell.error.value };
  return shell.status === "live" &&
    Option.isSome(shell.snapshot) &&
    shell.snapshot.value !== initialSnapshot
    ? { status: "ready" }
    : { status: "pending" };
}

export function sessionRefreshTargets<T extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<T>,
  selectedEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return selectedEnvironmentId === null
    ? environments
    : environments.filter(({ environmentId }) => environmentId === selectedEnvironmentId);
}

/** Partial success must not turn a useful refresh into a modal failure. */
export function sessionRefreshFailure(results: ReadonlyArray<PromiseSettledResult<void>>): unknown {
  if (results.length === 0 || results.some((result) => result.status === "fulfilled")) return null;
  const first = results[0];
  return first?.status === "rejected" ? first.reason : null;
}
