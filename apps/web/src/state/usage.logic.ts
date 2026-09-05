import {
  canRefreshProviderAvailability,
  type EnvironmentId,
  type ProviderAvailabilityEntry,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageSummaryInput,
} from "@t3tools/contracts";

/** Selects the Environment-scoped historical view without affecting Capacity inputs. */
export function selectHistoricalUsageEnvironments<
  TEnvironment extends { readonly environmentId: string },
>(environments: readonly TEnvironment[], environmentId: string | null): readonly TEnvironment[] {
  if (environmentId === null) return environments;
  return environments.filter((environment) => environment.environmentId === environmentId);
}

export interface CapacityRefreshTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export interface CapacityRefreshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly providers: readonly ProviderAvailabilityEntry[];
  readonly serverProviders: readonly ServerProvider[] | null;
}

export interface UsageRefreshPorts {
  readonly refreshUsageSummary: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: UsageSummaryInput;
  }) => void;
  readonly refreshProviderAvailability: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly refresh: true; readonly instanceId: ProviderInstanceId };
  }) => void;
}

export const capacityRefreshKey = (targets: readonly CapacityRefreshTarget[]): string =>
  JSON.stringify(
    [
      ...new Map(
        targets.map((target) => [
          JSON.stringify([target.environmentId, target.instanceId]),
          { environmentId: target.environmentId, instanceId: target.instanceId },
        ]),
      ).values(),
    ].toSorted(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.instanceId.localeCompare(right.instanceId),
    ),
  );

export const parseCapacityRefreshKey = (key: string): readonly CapacityRefreshTarget[] =>
  JSON.parse(key) as readonly CapacityRefreshTarget[];

export const replaceAvailabilityEntries = (
  cached: readonly ProviderAvailabilityEntry[],
  refreshed: readonly ProviderAvailabilityEntry[],
): readonly ProviderAvailabilityEntry[] => {
  if (refreshed.length === 0) return cached;
  const byInstance = new Map(cached.map((entry) => [entry.instanceId, entry]));
  for (const entry of refreshed) byInstance.set(entry.instanceId, entry);
  return [...byInstance.values()];
};

export const resolveAvailabilityEntries = (
  cached: readonly ProviderAvailabilityEntry[],
  live: readonly ProviderAvailabilityEntry[] | null,
  refreshed: readonly (readonly ProviderAvailabilityEntry[])[],
): readonly ProviderAvailabilityEntry[] =>
  refreshed.reduce(replaceAvailabilityEntries, live ?? cached);

export const hasUnsettledCapacityRefresh = (
  results: readonly { readonly _tag: string; readonly waiting: boolean }[],
): boolean => results.some((result) => result.waiting || result._tag === "Initial");

export type CapacityRefreshSettlementStep =
  | "wait-targets"
  | "refresh-base"
  | "wait-base"
  | "complete";

/**
 * Keep one-shot refresh results mounted until the ordinary cached query has
 * caught up. Otherwise a server without the passive stream briefly falls back
 * to the pre-refresh snapshot between those two requests.
 */
export function capacityRefreshSettlementStep(input: {
  readonly hasUnsettledTargetRefresh: boolean;
  readonly baseRefreshStarted: boolean;
  readonly baseQueryWaiting: boolean;
}): CapacityRefreshSettlementStep {
  if (input.hasUnsettledTargetRefresh) return "wait-targets";
  if (!input.baseRefreshStarted) return "refresh-base";
  return input.baseQueryWaiting ? "wait-base" : "complete";
}

export function capacityRefreshTargets(
  environments: readonly CapacityRefreshEnvironment[],
  mode: "stale" | "all" = "stale",
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
        mode === "all" ||
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

export function refreshHistoricalUsage(
  ports: UsageRefreshPorts,
  environments: readonly { readonly environmentId: EnvironmentId }[],
  input: UsageSummaryInput,
): void {
  for (const environment of environments) {
    ports.refreshUsageSummary({ environmentId: environment.environmentId, input });
  }
}

export function refreshProviderCapacity(
  ports: UsageRefreshPorts,
  targets: readonly CapacityRefreshTarget[],
): void {
  for (const target of parseCapacityRefreshKey(capacityRefreshKey(targets))) {
    ports.refreshProviderAvailability({
      environmentId: target.environmentId,
      input: { refresh: true, instanceId: target.instanceId },
    });
  }
}
