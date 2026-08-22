import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatform,
  HostMetricsSnapshot,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export interface EnvironmentHostMetricsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly supportsHostMetrics: boolean;
  readonly platform: ExecutionEnvironmentPlatform | null;
  readonly serverVersion: string | null;
  readonly snapshot: HostMetricsSnapshot | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

const hostMetricsOverviewAtom = Atom.make((get): readonly EnvironmentHostMetricsStatus[] => {
  const statuses: EnvironmentHostMetricsStatus[] = [];
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
      isPending: result?.waiting ?? false,
      error: result?._tag === "Failure" ? "Metrics unavailable" : null,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-host-metrics:overview"));

export function useHostMetricsOverview(): readonly EnvironmentHostMetricsStatus[] {
  return useAtomValue(hostMetricsOverviewAtom);
}

export function useLiveHostMetrics(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    environmentId !== null && enabled
      ? serverEnvironment.hostMetricsLive({
          environmentId,
          input: { sampleIntervalMs: 1_000 },
        })
      : null,
  );
}

export function useHostMetricsHistory(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    environmentId !== null && enabled
      ? serverEnvironment.hostMetricsHistory({
          environmentId,
          input: { windowMs: 15 * 60 * 1_000 },
        })
      : null,
  );
}
