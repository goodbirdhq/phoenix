import { useAtomValue } from "@effect/atom-react";
import { createScheduleEnvironmentAtoms } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentId, ScheduleSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentPresentation } from "./environments";
import { useEnvironments } from "./environments";

export const scheduleEnvironment = createScheduleEnvironmentAtoms(connectionAtomRuntime);

const environmentScheduleStatesAtom = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds.map(
      (environmentId) =>
        [environmentId, get(scheduleEnvironment.stateValueAtom(environmentId))] as const,
    ),
  ).pipe(Atom.withLabel(`web-schedules:${key}`));
});

function scheduleEnvironmentKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return JSON.stringify(environmentIds.toSorted());
}

export interface WebEnvironmentSchedules {
  readonly environment: EnvironmentPresentation;
  readonly online: boolean;
  readonly supportsSchedules: boolean;
  readonly source: "cache" | "live";
  readonly snapshotSequence: number;
  readonly schedules: ReadonlyArray<ScheduleSummary>;
}

export function useWebEnvironmentSchedules() {
  const { isReady, environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId).toSorted(),
    [environments],
  );
  const states = useAtomValue(
    environmentScheduleStatesAtom(scheduleEnvironmentKey(environmentIds)),
  );
  const stateById = useMemo(() => new Map(states), [states]);

  const projections = useMemo(
    () =>
      environments.map((environment) => {
        const state = stateById.get(environment.environmentId);
        const snapshot = state ? Option.getOrNull(state.snapshot) : null;
        return {
          environment,
          online: environment.connection.phase === "connected",
          supportsSchedules: environment.serverConfig?.environment.capabilities.schedules === true,
          source: state?.status === "live" ? ("live" as const) : ("cache" as const),
          snapshotSequence: snapshot?.sequence ?? 0,
          schedules: snapshot?.schedules ?? [],
        };
      }),
    [environments, stateById],
  );

  return { isReady, environments: projections };
}
