import { RegistryContext } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  evaluateSessionRefresh,
  sessionRefreshTargets,
  sessionRefreshFailure,
} from "./session-refresh.logic";
import { waitForSessionRefresh } from "./session-refresh";

export function useSessionRefresh(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  selectedEnvironmentId: EnvironmentId | null,
) {
  const registry = useContext(RegistryContext);
  const retry = useAtomCommand(environmentCatalog.retryNow, "session list refresh");
  const active = useRef<AbortController | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => () => active.current?.abort(), []);

  const onRefresh = useCallback(async () => {
    if (active.current) return;
    const targets = sessionRefreshTargets(environments, selectedEnvironmentId);
    if (targets.length === 0) return;
    const controller = new AbortController();
    active.current = controller;
    setRefreshing(true);
    try {
      if (registry.get(environmentCatalog.networkStatusValueAtom) === "offline") {
        throw new Error("You are offline. Reconnect to refresh your sessions.");
      }
      const results = await Promise.allSettled(
        targets.map(({ environmentId }) => {
          const connectionAtom = environmentCatalog.stateAtom(environmentId);
          const shellAtom = environmentShell.stateValueAtom(environmentId);
          const connection = () =>
            Option.getOrElse(
              AsyncResult.value(registry.get(connectionAtom)),
              () => AVAILABLE_CONNECTION_STATE,
            );
          const initialConnection = connection();
          const initialSnapshot = Option.getOrNull(registry.get(shellAtom).snapshot);
          return waitForSessionRefresh({
            signal: controller.signal,
            subscribe: (check) => {
              const cleanups = [
                registry.subscribe(connectionAtom, check),
                registry.subscribe(shellAtom, check),
                registry.subscribe(environmentCatalog.networkStatusValueAtom, check),
              ];
              return () => cleanups.forEach((cleanup) => cleanup());
            },
            check: () =>
              evaluateSessionRefresh({
                networkStatus: registry.get(environmentCatalog.networkStatusValueAtom),
                initialConnection,
                state: connection(),
                initialSnapshot,
                shell: registry.get(shellAtom),
              }),
            reconnect: async () => (await retry(environmentId))._tag === "Success",
          });
        }),
      );
      const failure = sessionRefreshFailure(results);
      if (failure !== null) throw failure;
    } catch (error) {
      if (!controller.signal.aborted) {
        Alert.alert(
          "Could not refresh sessions",
          error instanceof Error ? error.message : "Pull down to try again.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
      if (active.current === controller) active.current = null;
    }
  }, [environments, registry, retry, selectedEnvironmentId]);

  return { refreshing, onRefresh };
}
