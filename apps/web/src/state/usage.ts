/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  canRefreshProviderAvailability,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ProviderAvailabilityEntry,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { subscriptionAvailabilityPresentationState } from "@t3tools/client-runtime/usage/subscription-availability";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { selectHistoricalUsageEnvironments } from "./usage.logic";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export interface EnvironmentProviderAvailabilityStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** True until the availability RPC and provider-status projection both settle. */
  readonly isPending: boolean;
  /** An availability RPC failed after the provider-status projection had loaded. */
  readonly hasError: boolean;
  /** A fresh native reading is being collected while the last known value stays visible. */
  readonly isRefreshing: boolean;
  readonly refreshingInstanceIds: readonly ProviderInstanceId[];
  readonly providers: readonly ProviderAvailabilityEntry[];
  /** Provider snapshots carry enabled/auth facts used for account presentation. */
  readonly serverProviders: readonly ServerProvider[] | null;
  /** Environment-local Failover-group membership from the same config projection. */
  readonly providerInstances: ProviderInstanceConfigMap;
}

interface CapacityRefreshTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

const capacityRefreshKey = (targets: readonly CapacityRefreshTarget[]): string =>
  JSON.stringify(
    [
      ...new Map(
        targets.map((target) => [
          JSON.stringify([target.environmentId, target.instanceId]),
          {
            environmentId: target.environmentId,
            instanceId: target.instanceId,
          },
        ]),
      ).values(),
    ].toSorted(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.instanceId.localeCompare(right.instanceId),
    ),
  );

const parseCapacityRefreshKey = (key: string): readonly CapacityRefreshTarget[] =>
  JSON.parse(key) as readonly CapacityRefreshTarget[];

const replaceAvailabilityEntries = (
  cached: readonly ProviderAvailabilityEntry[],
  refreshed: readonly ProviderAvailabilityEntry[],
): readonly ProviderAvailabilityEntry[] => {
  if (refreshed.length === 0) return cached;
  const byInstance = new Map(cached.map((entry) => [entry.instanceId, entry]));
  for (const entry of refreshed) byInstance.set(entry.instanceId, entry);
  return [...byInstance.values()];
};

const providerAvailabilityAtom = Atom.family((refreshKey: string) =>
  Atom.make((get): readonly EnvironmentProviderAvailabilityStatus[] => {
    const presentations = get(environmentPresentations.presentationsAtom);
    const refreshTargets = parseCapacityRefreshKey(refreshKey);
    const statuses: EnvironmentProviderAvailabilityStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const cachedResult = get(
        serverEnvironment.providerAvailability({
          environmentId,
          input: {},
        }),
      );
      const cachedValue = Option.getOrNull(AsyncResult.value(cachedResult));
      const liveValue = Option.getOrNull(
        AsyncResult.value(
          get(
            serverEnvironment.providerAvailabilityChanges({
              environmentId,
              input: {},
            }),
          ),
        ),
      );
      const environmentRefreshTargets = refreshTargets.filter(
        (target) => target.environmentId === environmentId,
      );
      const refreshResults = environmentRefreshTargets.map((target) =>
        get(
          serverEnvironment.providerAvailability({
            environmentId,
            input: { refresh: true, instanceId: target.instanceId },
          }),
        ),
      );
      const providers = refreshResults.reduce(
        (entries, result) => {
          const value = Option.getOrNull(AsyncResult.value(result));
          return value === null ? entries : replaceAvailabilityEntries(entries, value.providers);
        },
        liveValue?.providers ?? cachedValue?.providers ?? [],
      );
      const serverProviders = get(serverEnvironment.providersValueAtom(environmentId));
      const providerInstances =
        get(serverEnvironment.settingsValueAtom(environmentId))?.providerInstances ?? {};
      const presentationState = subscriptionAvailabilityPresentationState({
        availabilityQueryPending:
          cachedValue === null &&
          liveValue === null &&
          (cachedResult.waiting || refreshResults.some((result) => result.waiting)),
        availabilityQueryFailed:
          liveValue === null &&
          (cachedResult._tag === "Failure" ||
            refreshResults.some((result) => result._tag === "Failure")),
        providerProjectionReady: serverProviders !== null,
      });
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        // A valid quota snapshot alone does not say whether an instance is
        // enabled or authenticated. Wait for that projection instead of
        // flashing the final empty state while it is still loading.
        ...presentationState,
        isRefreshing: refreshResults.some((result) => result.waiting),
        refreshingInstanceIds: environmentRefreshTargets.flatMap((target, index) =>
          refreshResults[index]?.waiting ? [target.instanceId] : [],
        ),
        providers,
        serverProviders,
        providerInstances,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:provider-availability:${refreshKey}`)),
);

const NO_CAPACITY_REFRESH_KEY = capacityRefreshKey([]);

/**
 * The cached per-instance availability reading, for surfaces that want the
 * numbers without the Usage page's summaries.
 *
 * Shares one non-refreshing atom with every reader. Mounting a reader subscribes
 * it to availability changes and may start the cached query, but never asks a
 * provider CLI for a forced refresh.
 */
export function useProviderAvailability(): readonly EnvironmentProviderAvailabilityStatus[] {
  return useAtomValue(providerAvailabilityAtom(NO_CAPACITY_REFRESH_KEY));
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  /** Every Environment that can be selected for historical usage. Capacity stays global. */
  readonly allEnvironments: readonly EnvironmentUsageStatus[];
  /** The selected Environment's historical usage, or every Environment for All Environments. */
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  /** Historical summaries are being rescanned, including while cached totals remain visible. */
  readonly isUsageRefreshing: boolean;
  /** Rescans historical usage without probing Provider quota. */
  readonly refreshUsage: (input?: UsageSummaryInput) => void;
  /** Revalidates missing, stale or failed subscription readings without rescanning usage. */
  readonly refreshCapacity: (target?: CapacityRefreshTarget) => void;
  readonly providerAvailability: readonly EnvironmentProviderAvailabilityStatus[];
  readonly isProviderAvailabilityPending: boolean;
  readonly isCapacityRefreshing: boolean;
  readonly hasProviderAvailabilityError: boolean;
}

function staleCapacityTargets(
  environments: readonly EnvironmentProviderAvailabilityStatus[],
): readonly CapacityRefreshTarget[] {
  const targets: CapacityRefreshTarget[] = [];
  for (const environment of environments) {
    if (environment.isPending || environment.serverProviders === null) continue;
    const availabilityByInstance = new Map(
      environment.providers.map((entry) => [entry.instanceId, entry.availability]),
    );
    for (const provider of environment.serverProviders) {
      if (!canRefreshProviderAvailability(provider)) continue;
      const availability = availabilityByInstance.get(provider.instanceId);
      if (
        availability === undefined ||
        availability.observedAt === undefined ||
        availability.status === "unknown" ||
        availability.stale !== undefined
      ) {
        targets.push({
          environmentId: environment.environmentId,
          instanceId: provider.instanceId,
        });
      }
    }
  }
  return targets;
}

export function useUsage(
  input: UsageSummaryInput,
  historicalEnvironmentId: EnvironmentId | null = null,
): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const allEnvironments = useAtomValue(atom);
  const environments = useMemo(
    () => selectHistoricalUsageEnvironments(allEnvironments, historicalEnvironmentId),
    [allEnvironments, historicalEnvironmentId],
  );
  const [refreshKey, setRefreshKey] = useState(NO_CAPACITY_REFRESH_KEY);
  const [focusGeneration, setFocusGeneration] = useState(0);
  const attemptedFocusGeneration = useRef(-1);
  const providerAvailability = useAtomValue(providerAvailabilityAtom(refreshKey));

  const beginCapacityRefresh = useCallback((targets: readonly CapacityRefreshTarget[]) => {
    if (targets.length === 0) return;
    for (const target of targets) {
      appAtomRegistry.refresh(
        serverEnvironment.providerAvailability({
          environmentId: target.environmentId,
          input: { refresh: true, instanceId: target.instanceId },
        }),
      );
    }
    setRefreshKey((current) =>
      capacityRefreshKey([...parseCapacityRefreshKey(current), ...targets]),
    );
  }, []);

  // A refresh query is one-shot. Once every target settles, re-read the normal
  // cached query and return to it; the last known values stayed visible while
  // the native probes ran.
  useEffect(() => {
    if (
      refreshKey !== NO_CAPACITY_REFRESH_KEY &&
      !providerAvailability.some((environment) => environment.isRefreshing)
    ) {
      const environmentIds = new Set(
        parseCapacityRefreshKey(refreshKey).map((target) => target.environmentId),
      );
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(
          serverEnvironment.providerAvailability({
            environmentId,
            input: {},
          }),
        );
      }
      setRefreshKey(NO_CAPACITY_REFRESH_KEY);
    }
  }, [providerAvailability, refreshKey]);

  useEffect(() => {
    const onFocus = () => setFocusGeneration((generation) => generation + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Revalidate once per mount/focus cycle after configuration and cached quota
  // have settled. A failed refresh is not retried in a render loop; the next
  // focus or explicit action is the next opportunity.
  useEffect(() => {
    if (
      refreshKey !== NO_CAPACITY_REFRESH_KEY ||
      providerAvailability.some((environment) => environment.isPending) ||
      attemptedFocusGeneration.current === focusGeneration
    ) {
      return;
    }
    attemptedFocusGeneration.current = focusGeneration;
    beginCapacityRefresh(staleCapacityTargets(providerAvailability));
  }, [beginCapacityRefresh, focusGeneration, providerAvailability, refreshKey]);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refreshUsage = useCallback(
    (refreshInput: UsageSummaryInput = input) => {
      for (const environment of environments) {
        appAtomRegistry.refresh(
          serverEnvironment.usageSummary({
            environmentId: environment.environmentId,
            input: refreshInput,
          }),
        );
      }
    },
    [environments, input],
  );

  const refreshCapacity = useCallback(
    (target?: CapacityRefreshTarget) =>
      beginCapacityRefresh(
        target === undefined ? staleCapacityTargets(providerAvailability) : [target],
      ),
    [beginCapacityRefresh, providerAvailability],
  );

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    allEnvironments,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    isUsageRefreshing: environments.some((environment) => environment.isPending),
    refreshUsage,
    refreshCapacity,
    providerAvailability,
    isProviderAvailabilityPending: providerAvailability.some(
      (environment) => environment.isPending,
    ),
    isCapacityRefreshing: providerAvailability.some((environment) => environment.isRefreshing),
    hasProviderAvailabilityError: providerAvailability.some((environment) => environment.hasError),
  };
}
