import { useAtomValue } from "@effect/atom-react";
import {
  createSalesEnvironmentAtoms,
  isSalesConfigured,
} from "@t3tools/client-runtime/state/sales";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";

export const salesEnvironment = createSalesEnvironmentAtoms(connectionAtomRuntime);

/** Environments whose settings name a sales engine; the Sales area shows only for these. */
export function useSalesEnvironments() {
  const { isReady, environments } = useEnvironments();
  const configured = useMemo(
    () => environments.filter((environment) => isSalesConfigured(environment.serverConfig)),
    [environments],
  );
  return { isReady, environments: configured };
}

/**
 * The Sales environment a page shows: the one named in the URL when it is configured, else the
 * first configured one. Null while none is.
 */
export function useSalesTarget(requested: string | undefined) {
  const { isReady, environments } = useSalesEnvironments();
  const target =
    environments.find((environment) => environment.environmentId === requested) ??
    environments[0] ??
    null;
  return { isReady, environments, target };
}

/** Subscribes the environment's Sales stream while mounted; the server polls only then. */
export function useSalesState(environmentId: EnvironmentId) {
  return useAtomValue(salesEnvironment.stateValueAtom(environmentId));
}
