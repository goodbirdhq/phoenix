/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * Mirror of `apps/web/src/state/usage.ts` over mobile's atom wiring; the merge
 * rules themselves live in `@t3tools/shared/usageMerge`.
 *
 * @module state/usage
 */
import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { findUsageAccount } from "@t3tools/client-runtime/usage/accounts";
import { buildUsageAccounts, type UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ProviderAvailabilityEntry,
  type ServerProvider,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { refreshUsage } from "@t3tools/client-runtime/state/usage";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { subscriptionAvailabilityPresentationState } from "@t3tools/client-runtime/usage/subscription-availability";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export interface EnvironmentProviderAvailabilityStatus {
  readonly isConnected: boolean;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly providers: readonly ProviderAvailabilityEntry[];
  readonly serverProviders: readonly ServerProvider[] | null;
}

const providerAvailabilityAtom = Atom.family((refresh: boolean) =>
  Atom.make((get): readonly EnvironmentProviderAvailabilityStatus[] => {
    const presentations = get(environmentPresentations.presentationsAtom);
    const statuses: EnvironmentProviderAvailabilityStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(
        serverEnvironment.providerAvailability({
          environmentId,
          input: refresh ? { refresh: true } : {},
        }),
      );
      const value = Option.getOrNull(AsyncResult.value(result));
      const serverProviders = get(serverEnvironment.providersValueAtom(environmentId));
      const presentationState = subscriptionAvailabilityPresentationState({
        availabilityQueryPending: result.waiting,
        availabilityQueryFailed: result._tag === "Failure",
        providerProjectionReady: serverProviders !== null,
      });
      statuses.push({
        environmentId,
        isConnected: presentation.connection.phase === "connected",
        label: presentation.entry.target.label,
        // Availability does not carry enabled/auth facts. Keep the loading
        // state until the separate provider projection is ready, otherwise a
        // fast availability response briefly reads as a final empty result.
        ...presentationState,
        providers: value?.providers ?? [],
        serverProviders,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:provider-availability:${refresh ? "refresh" : "cached"}`)),
);

/**
 * The cached per-instance availability reading, without subscribing to the
 * Usage screen's summaries or asking provider CLIs for a fresh reading.
 */
export function useProviderAvailability(): readonly EnvironmentProviderAvailabilityStatus[] {
  return useAtomValue(providerAvailabilityAtom(false));
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
        isConnected: presentation.connection.phase === "connected",
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly allEnvironments: readonly EnvironmentUsageStatus[];
  readonly accounts: readonly UsageAccount[];
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported in the environment menu: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  /** Refreshes the supplied range, or the currently rendered range when omitted. */
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
  readonly providerAvailability: readonly EnvironmentProviderAvailabilityStatus[];
  readonly isProviderAvailabilityPending: boolean;
  readonly hasProviderAvailabilityError: boolean;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
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
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? allEnvironments
        : allEnvironments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [allEnvironments, selectedEnvironmentIds],
  );
  const [refreshingAvailability, setRefreshingAvailability] = useState(false);
  const providerAvailability = useAtomValue(providerAvailabilityAtom(refreshingAvailability));

  // The refresh flag is a one-shot provider read, never durable screen state.
  useEffect(() => {
    if (
      refreshingAvailability &&
      !providerAvailability.some((environment) => environment.isPending)
    ) {
      for (const environment of providerAvailability) {
        appAtomRegistry.refresh(
          serverEnvironment.providerAvailability({
            environmentId: environment.environmentId,
            input: {},
          }),
        );
      }
      setRefreshingAvailability(false);
    }
  }, [providerAvailability, refreshingAvailability]);

  const refresh = useCallback(
    async (nextInput?: UsageSummaryInput) => {
      await refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        environmentIds: selectedEnvironments.map(({ environmentId }) => environmentId),
        input: nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput),
      });
      setRefreshingAvailability(true);
    },
    [selectedEnvironments, windowKey],
  );

  const accounts = useMemo(
    () => buildUsageAccounts(providerAvailability, allEnvironments),
    [providerAvailability, allEnvironments],
  );

  const account = findUsageAccount(accounts, accountKey);
  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary:
                accountKey === null
                  ? environment.summary
                  : account
                    ? scopeAccountHistory(environment.summary, environment.environmentId, account)
                    : {
                        ...environment.summary,
                        sources: [],
                        buckets: [],
                        sessionUsage: [],
                        threadCreations: [],
                      },
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [selectedEnvironments, account, accountKey]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    allEnvironments,
    accounts,
    merged,
    environments: allEnvironments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
    providerAvailability,
    isProviderAvailabilityPending: providerAvailability.some(
      (environment) => environment.isPending,
    ),
    hasProviderAvailabilityError: providerAvailability.some((environment) => environment.hasError),
  };
}
