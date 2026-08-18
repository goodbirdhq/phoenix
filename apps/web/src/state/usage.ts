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
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ProviderAvailabilityEntry,
  type ServerProvider,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { subscriptionAvailabilityPresentationState } from "@t3tools/client-runtime/usage/subscription-availability";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

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
  readonly providers: readonly ProviderAvailabilityEntry[];
  /** Provider snapshots carry enabled/auth facts used for account presentation. */
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
        label: presentation.entry.target.label,
        // A valid quota snapshot alone does not say whether an instance is
        // enabled or authenticated. Wait for that projection instead of
        // flashing the final empty state while it is still loading.
        ...presentationState,
        providers: value?.providers ?? [],
        serverProviders,
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:provider-availability:${refresh ? "refresh" : "cached"}`)),
);

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
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  /** Refreshes the supplied range, or the currently rendered range when omitted. */
  readonly refresh: (input?: UsageSummaryInput) => void;
  readonly providerAvailability: readonly EnvironmentProviderAvailabilityStatus[];
  readonly isProviderAvailabilityPending: boolean;
  readonly hasProviderAvailabilityError: boolean;
}

export function useUsage(input: UsageSummaryInput): UsageView {
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
  const environments = useAtomValue(atom);
  const [refreshingAvailability, setRefreshingAvailability] = useState(false);
  const providerAvailability = useAtomValue(providerAvailabilityAtom(refreshingAvailability));

  // `refresh` is an explicit, one-shot request flag. Once that query settles,
  // return to the regular cached read instead of repeatedly running a provider
  // CLI on every render or revisit.
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

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(
    (refreshInput: UsageSummaryInput = input) => {
      for (const environment of environments) {
        appAtomRegistry.refresh(
          serverEnvironment.usageSummary({
            environmentId: environment.environmentId,
            input: refreshInput,
          }),
        );
        appAtomRegistry.refresh(
          serverEnvironment.providerAvailability({
            environmentId: environment.environmentId,
            // This request asks the provider to collect a fresh reading. The
            // default query deliberately reads its short-lived cache instead.
            input: { refresh: true },
          }),
        );
      }
      setRefreshingAvailability(true);
    },
    [environments, input],
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
    environments,
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
