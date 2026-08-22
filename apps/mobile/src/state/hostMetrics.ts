import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  HostMetricsSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export interface MobileEnvironmentHostMetricsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly supportsHostMetrics: boolean;
  readonly platform: ExecutionEnvironmentPlatform | null;
  readonly serverVersion: string | null;
  readonly snapshot: HostMetricsSnapshot | null;
  readonly pending: boolean;
  readonly failed: boolean;
}

const overviewAtom = Atom.make((get): readonly MobileEnvironmentHostMetricsStatus[] => {
  const statuses: MobileEnvironmentHostMetricsStatus[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const supportsHostMetrics =
      presentation.serverConfig?.environment.capabilities.hostMetrics === true;
    const connected = presentation.connection.phase === "connected";
    const result =
      connected && supportsHostMetrics
        ? get(serverEnvironment.hostMetrics({ environmentId, input: {} }))
        : null;
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      connectionPhase: presentation.connection.phase,
      supportsHostMetrics,
      platform: presentation.serverConfig?.environment.platform ?? null,
      serverVersion: presentation.serverConfig?.environment.serverVersion ?? null,
      snapshot: result === null ? null : Option.getOrNull(AsyncResult.value(result)),
      pending: result?.waiting ?? false,
      failed: result?._tag === "Failure",
    });
  }
  return statuses;
}).pipe(Atom.withLabel("mobile-host-metrics:overview"));

export function useMobileHostMetricsOverview() {
  const environments = useAtomValue(overviewAtom);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      if (environment.connectionPhase === "connected" && environment.supportsHostMetrics) {
        appAtomRegistry.refresh(
          serverEnvironment.hostMetrics({ environmentId: environment.environmentId, input: {} }),
        );
      }
    }
  }, [environments]);
  return { environments, refresh };
}

export function useMobileLiveHostMetrics(environmentId: EnvironmentId, enabled: boolean) {
  return useEnvironmentQuery(
    enabled
      ? serverEnvironment.hostMetricsLive({
          environmentId,
          input: { sampleIntervalMs: 1_000 },
        })
      : null,
  );
}

export function useMobileHostMetricsHistory(environmentId: EnvironmentId, enabled: boolean) {
  return useEnvironmentQuery(
    enabled
      ? serverEnvironment.hostMetricsHistory({
          environmentId,
          input: { windowMs: 15 * 60 * 1_000 },
        })
      : null,
  );
}
