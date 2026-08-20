import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentScheduleState } from "@t3tools/client-runtime/state/schedules";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ScheduleCommand,
  type ScheduleDetail,
  type ScheduleHistoryCursor,
  type ScheduleId,
  type ScheduleSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { useProjects, useServerConfigs } from "../../state/entities";
import { scheduleEnvironment } from "../../state/schedules";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";
import { runtime } from "../../lib/runtime";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import { useEnvironmentQuery } from "../../state/query";

export interface MobileScheduleEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly online: boolean;
  readonly supportsSchedules: boolean;
  readonly source: "empty" | "cache" | "live";
  readonly schedules: readonly ScheduleSummary[];
  readonly projects: readonly EnvironmentProject[];
  readonly synchronizing: boolean;
  readonly error: string | null;
}

const scheduleOverviewAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return [...presentations.entries()].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    online: presentation.connection.phase === "connected",
    state: get(scheduleEnvironment.stateValueAtom(environmentId)),
  }));
}).pipe(Atom.withLabel("mobile:schedule-overview"));

function scheduleStateSource(state: EnvironmentScheduleState): "empty" | "cache" | "live" {
  if (state.status === "live") return "live";
  return Option.isSome(state.snapshot) ? "cache" : "empty";
}

export function useMobileScheduleOverview(): {
  readonly environments: readonly MobileScheduleEnvironment[];
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const overview = useAtomValue(scheduleOverviewAtom);
  const projects = useProjects();
  const configs = useServerConfigs();
  const environments = useMemo(
    () =>
      overview.map(
        ({ environmentId, label, online, state }): MobileScheduleEnvironment => ({
          environmentId,
          label,
          online,
          supportsSchedules:
            configs.get(environmentId)?.environment.capabilities.schedules === true,
          source: scheduleStateSource(state),
          schedules: Option.match(state.snapshot, {
            onNone: () => [],
            onSome: (snapshot) => snapshot.schedules,
          }),
          projects: projects.filter((project) => project.environmentId === environmentId),
          synchronizing: state.status === "synchronizing",
          error: Option.getOrNull(state.error),
        }),
      ),
    [configs, overview, projects],
  );
  const refresh = useCallback(() => {
    for (const environment of overview) {
      appAtomRegistry.refresh(scheduleEnvironment.stateAtom(environment.environmentId));
    }
  }, [overview]);
  return {
    environments,
    isLoading:
      environments.length > 0 &&
      environments.every(
        (environment) => environment.source === "empty" && environment.synchronizing,
      ),
    refresh,
  };
}

const EMPTY_SCHEDULE_DETAIL_RESULT = Atom.make(
  AsyncResult.initial<ScheduleDetail, never>(false),
).pipe(Atom.withLabel("mobile:schedule-detail:empty"));

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Schedule request failed.";
}

export function useScheduleDispatch() {
  const dispatch = useAtomCommand(scheduleEnvironment.dispatch, {
    label: "Schedule action",
    reportFailure: false,
  });
  return useCallback(
    async (environmentId: EnvironmentId, command: ScheduleCommand) => {
      const result = await dispatch({ environmentId, input: command });
      return result._tag === "Success"
        ? { ok: true as const }
        : { ok: false as const, error: errorMessage(result.cause) };
    },
    [dispatch],
  );
}

export function useMobileScheduleDetail(
  environmentId: EnvironmentId | null,
  scheduleId: ScheduleId | null,
  liveEnabled = true,
  revision: number | null = null,
) {
  const detailAtom =
    environmentId === null || scheduleId === null || !liveEnabled
      ? EMPTY_SCHEDULE_DETAIL_RESULT
      : scheduleEnvironment.detail({
          environmentId,
          input: revision === null ? { scheduleId } : { scheduleId, revision },
        });
  const result = useAtomValue(detailAtom);
  const liveDetail = Option.getOrNull(AsyncResult.value(result));
  const [cachedDetail, setCachedDetail] = useState<ScheduleDetail | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(environmentId === null || scheduleId === null);

  useEffect(() => {
    if (environmentId === null || scheduleId === null) {
      setCachedDetail(null);
      setCacheLoaded(true);
      return;
    }
    let active = true;
    setCachedDetail(null);
    setCacheLoaded(false);
    void runtime
      .runPromise(
        EnvironmentCacheStore.pipe(
          Effect.flatMap(
            (cache) =>
              cache.loadScheduleDetail?.(environmentId, scheduleId) ??
              Effect.succeed(Option.none()),
          ),
        ),
      )
      .then((detail) => {
        if (active) {
          setCachedDetail(Option.getOrNull(detail));
          setCacheLoaded(true);
        }
      })
      .catch(() => {
        if (active) setCacheLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [environmentId, scheduleId]);

  useEffect(() => {
    if (liveDetail === null || environmentId === null) return;
    setCachedDetail(liveDetail);
  }, [environmentId, liveDetail]);

  const refresh = useCallback(() => {
    if (environmentId !== null && scheduleId !== null && liveEnabled) {
      appAtomRegistry.refresh(detailAtom);
    }
  }, [detailAtom, environmentId, liveEnabled, scheduleId]);

  return {
    detail: liveDetail ?? cachedDetail,
    source:
      liveDetail !== null
        ? ("live" as const)
        : cachedDetail !== null
          ? ("cache" as const)
          : ("empty" as const),
    isLoading:
      liveDetail === null &&
      cachedDetail === null &&
      (!cacheLoaded || (liveEnabled && result.waiting)),
    error: result._tag === "Failure" && cachedDetail === null ? errorMessage(result.cause) : null,
    refresh,
  };
}

export function useMobileScheduleHistoryPage(input: {
  readonly environmentId: EnvironmentId;
  readonly scheduleId: ScheduleId;
  readonly cursor: ScheduleHistoryCursor | null;
  readonly limit: number;
  readonly enabled: boolean;
}) {
  return useEnvironmentQuery(
    input.enabled && input.cursor !== null
      ? scheduleEnvironment.history({
          environmentId: input.environmentId,
          input: {
            scheduleId: input.scheduleId,
            cursor: input.cursor,
            limit: input.limit,
          },
        })
      : null,
  );
}
