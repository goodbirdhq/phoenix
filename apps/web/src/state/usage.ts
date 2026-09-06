/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import {
  buildUsageAccounts,
  findUsageAccount,
  type UsageAccount,
} from "@t3tools/client-runtime/usage/accounts";
import { useAtomValue } from "@effect/atom-react";
import {
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
import {
  capacityRefreshKey,
  capacityRefreshSettlementStep,
  hasUnsettledCapacityRefresh,
  parseCapacityRefreshKey,
  refreshHistoricalUsage,
  refreshProviderCapacity,
  resolveAvailabilityEntries,
  selectHistoricalUsageEnvironments,
  capacityRefreshTargets,
  type CapacityRefreshTarget,
  type UsageRefreshPorts,
} from "./usage.logic";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export interface EnvironmentProviderAvailabilityStatus {
  readonly isConnected: boolean;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** True until the availability RPC and provider-status projection both settle. */
  readonly isPending: boolean;
  /** An availability RPC failed after the provider-status projection had loaded. */
  readonly hasError: boolean;
  /** A fresh native reading is being collected while the last known value stays visible. */
  readonly isRefreshing: boolean;
  /** A targeted query has not produced either a success or failure yet. */
  readonly hasUnsettledRefresh: boolean;
  /** The ordinary cached query is catching up after a targeted probe. */
  readonly isBaseQueryRefreshing: boolean;
  readonly refreshingInstanceIds: readonly ProviderInstanceId[];
  readonly providers: readonly ProviderAvailabilityEntry[];
  /** Provider snapshots carry enabled/auth facts used for account presentation. */
  readonly serverProviders: readonly ServerProvider[] | null;
  /** Environment-local Failover-group membership from the same config projection. */
  readonly providerInstances: ProviderInstanceConfigMap;
}

const usageRefreshPorts: UsageRefreshPorts = {
  refreshUsageSummary: (target) => appAtomRegistry.refresh(serverEnvironment.usageSummary(target)),
  refreshProviderAvailability: (target) =>
    appAtomRegistry.refresh(serverEnvironment.providerAvailability(target)),
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
      const connected = presentation.connection.phase === "connected";
      const hasUnsettledTargetRefresh = connected && hasUnsettledCapacityRefresh(refreshResults);
      const isSynchronizingBaseQuery =
        connected &&
        environmentRefreshTargets.length > 0 &&
        !hasUnsettledTargetRefresh &&
        cachedResult.waiting;
      const providers = resolveAvailabilityEntries(
        cachedValue?.providers ?? [],
        liveValue?.providers ?? null,
        refreshResults.flatMap((result) => {
          const value = Option.getOrNull(AsyncResult.value(result));
          return value === null ? [] : [value.providers];
        }),
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
          (liveValue === null && cachedResult._tag === "Failure") ||
          refreshResults.some((result) => result._tag === "Failure"),
        providerProjectionReady: serverProviders !== null,
      });
      statuses.push({
        environmentId,
        isConnected: presentation.connection.phase === "connected",
        label: presentation.entry.target.label,
        // A valid quota snapshot alone does not say whether an instance is
        // enabled or authenticated. Wait for that projection instead of
        // flashing the final empty state while it is still loading.
        ...presentationState,
        isRefreshing:
          connected &&
          (refreshResults.some((result) => result.waiting) || isSynchronizingBaseQuery),
        hasUnsettledRefresh: hasUnsettledTargetRefresh,
        isBaseQueryRefreshing: connected && cachedResult.waiting,
        refreshingInstanceIds: environmentRefreshTargets.flatMap((target, index) =>
          connected && (refreshResults[index]?.waiting || isSynchronizingBaseQuery)
            ? [target.instanceId]
            : [],
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
const activeCapacityRefreshAtom = Atom.make(NO_CAPACITY_REFRESH_KEY);

/**
 * The cached per-instance availability reading, for surfaces that want the
 * numbers without the Usage page's summaries.
 *
 * Shares the active refresh snapshot with every reader. Mounting a reader subscribes
 * it to availability changes and may start the cached query, but never asks a
 * provider CLI for a forced refresh.
 */
export function useProviderAvailability(): readonly EnvironmentProviderAvailabilityStatus[] {
  const refreshKey = useAtomValue(activeCapacityRefreshAtom);
  return useAtomValue(providerAvailabilityAtom(refreshKey));
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

const sidebarHistoryAtom = Atom.make<readonly EnvironmentUsageStatus[]>([]);

/** Shares the page's selected history window without issuing another usage query. */
export function useUsageSidebarHistory() {
  return useAtomValue(sidebarHistoryAtom);
}

export interface UsageView {
  readonly accounts: readonly UsageAccount[];
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
  /** Revalidates eligible subscription readings without rescanning usage. */
  readonly refreshCapacity: (targets?: readonly CapacityRefreshTarget[]) => void;
  readonly providerAvailability: readonly EnvironmentProviderAvailabilityStatus[];
  readonly isProviderAvailabilityPending: boolean;
  readonly isCapacityRefreshing: boolean;
  readonly hasProviderAvailabilityError: boolean;
}

export function useUsage(
  input: UsageSummaryInput,
  historicalEnvironmentId: EnvironmentId | null = null,
  accountKey: string | null = null,
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
        includeSessions: input.includeSessions,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      input.includeSessions,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const allEnvironments = useAtomValue(atom);
  const environments = useMemo(
    () => selectHistoricalUsageEnvironments(allEnvironments, historicalEnvironmentId),
    [allEnvironments, historicalEnvironmentId],
  );
  useEffect(() => {
    appAtomRegistry.set(sidebarHistoryAtom, environments);
  }, [environments]);
  useEffect(() => () => appAtomRegistry.set(sidebarHistoryAtom, []), []);
  const refreshKey = useAtomValue(activeCapacityRefreshAtom);
  const setRefreshKey = useCallback((value: string | ((current: string) => string)) => {
    appAtomRegistry.set(
      activeCapacityRefreshAtom,
      typeof value === "function" ? value(appAtomRegistry.get(activeCapacityRefreshAtom)) : value,
    );
  }, []);
  useEffect(
    () => () => appAtomRegistry.set(activeCapacityRefreshAtom, NO_CAPACITY_REFRESH_KEY),
    [],
  );
  const [focusGeneration, setFocusGeneration] = useState(0);
  const attemptedFocusGeneration = useRef(-1);
  const baseRefreshStartedForKey = useRef<string | null>(null);
  const providerAvailability = useAtomValue(providerAvailabilityAtom(refreshKey));

  const beginCapacityRefresh = useCallback(
    (targets: readonly CapacityRefreshTarget[]) => {
      if (targets.length === 0) return;
      refreshProviderCapacity(usageRefreshPorts, targets);
      setRefreshKey((current) =>
        capacityRefreshKey([...parseCapacityRefreshKey(current), ...targets]),
      );
    },
    [setRefreshKey],
  );

  // A refresh query is one-shot. Once every target settles, re-read the normal
  // cached query and return to it; the last known values stayed visible while
  // the native probes ran.
  useEffect(() => {
    if (refreshKey === NO_CAPACITY_REFRESH_KEY) {
      baseRefreshStartedForKey.current = null;
      return;
    }
    const environmentIds = new Set(
      parseCapacityRefreshKey(refreshKey).map((target) => target.environmentId),
    );
    const targetedEnvironments = providerAvailability.filter((environment) =>
      environmentIds.has(environment.environmentId),
    );
    const step = capacityRefreshSettlementStep({
      hasUnsettledTargetRefresh: targetedEnvironments.some(
        (environment) => environment.hasUnsettledRefresh,
      ),
      baseRefreshStarted: baseRefreshStartedForKey.current === refreshKey,
      baseQueryWaiting: targetedEnvironments.some(
        (environment) => environment.isBaseQueryRefreshing,
      ),
    });
    if (step === "refresh-base") {
      baseRefreshStartedForKey.current = refreshKey;
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(
          serverEnvironment.providerAvailability({
            environmentId,
            input: {},
          }),
        );
      }
      return;
    }
    if (step === "complete") {
      baseRefreshStartedForKey.current = null;
      setRefreshKey(NO_CAPACITY_REFRESH_KEY);
    }
  }, [providerAvailability, refreshKey, setRefreshKey]);

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
    beginCapacityRefresh(capacityRefreshTargets(providerAvailability));
  }, [beginCapacityRefresh, focusGeneration, providerAvailability, refreshKey]);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refreshUsage = useCallback(
    (refreshInput: UsageSummaryInput = input) => {
      refreshHistoricalUsage(usageRefreshPorts, environments, refreshInput);
    },
    [environments, input],
  );

  const refreshCapacity = useCallback(
    (targets?: readonly CapacityRefreshTarget[]) =>
      beginCapacityRefresh(capacityRefreshTargets(providerAvailability, "all", targets)),
    [beginCapacityRefresh, providerAvailability],
  );

  const accounts = useMemo(
    () => buildUsageAccounts(providerAvailability, allEnvironments),
    [providerAvailability, allEnvironments],
  );

  const selectedAccount = findUsageAccount(accounts, accountKey);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary:
                accountKey === null
                  ? environment.summary
                  : selectedAccount
                    ? scopeAccountHistory(
                        environment.summary,
                        environment.environmentId,
                        selectedAccount,
                      )
                    : {
                        ...environment.summary,
                        buckets: [],
                        sources: [],
                        sessionUsage: [],
                        threadCreations: [],
                      },
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments, accountKey, selectedAccount]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    accounts,
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
