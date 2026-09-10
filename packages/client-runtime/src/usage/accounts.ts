import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderAvailabilityEntry,
  type ServerProvider,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
/** Status and history are separate reads; an account remains visible without history. */
interface AccountEnvironment {
  readonly isConnected?: boolean;
  readonly environmentId: string;
  readonly label: string;
  readonly serverProviders: readonly ServerProvider[] | null;
  readonly providers: readonly ProviderAvailabilityEntry[];
}
interface HistoryEnvironment {
  readonly environmentId: string;
  readonly summary: UsageSummary | null;
}

export interface UsageAccountMembership {
  readonly isConnected: boolean | undefined;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  /** Store associations only. A shared store does not attribute its spend to this account. */
  readonly historySources: readonly UsageSource[];
  readonly historyMembershipKnown: boolean;
}

export interface UsageAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly name: string;
  readonly emails: readonly string[];
  readonly identityVerified: boolean;
  readonly memberships: readonly UsageAccountMembership[];
}

const USAGE_DRIVERS = new Set(["claudeAgent", "codex", "opencode", "grok"]);
/** Builds current account membership without inferring identity from email, plan or history. */
export function buildUsageAccounts(
  environments: readonly AccountEnvironment[],
  histories: readonly HistoryEnvironment[],
): readonly UsageAccount[] {
  const historyByEnvironment = new Map(
    histories.map((entry) => [entry.environmentId, entry.summary]),
  );
  const groups = new Map<
    string,
    {
      driver: ServerProvider["driver"];
      identityVerified: boolean;
      memberships: UsageAccountMembership[];
    }
  >();
  for (const environment of environments) {
    const availabilityByInstance = new Map(
      environment.providers.map((entry) => [entry.instanceId, entry]),
    );
    const summary = historyByEnvironment.get(environment.environmentId);
    for (const provider of environment.serverProviders ?? []) {
      if (!provider.enabled || !USAGE_DRIVERS.has(provider.driver)) continue;
      const reading = availabilityByInstance.get(provider.instanceId);
      // Logged-out/unknown instances must not inherit a former login's quota identity.
      const identity =
        provider.auth.status === "authenticated" &&
        reading?.driver === provider.driver &&
        reading.availability.stale === undefined
          ? reading.availability.account
          : undefined;
      const verified = identity?.verification === "native_verified";
      const key = JSON.stringify(
        verified
          ? [provider.driver, "account", identity.id]
          : [provider.driver, "instance", environment.environmentId, provider.instanceId],
      );
      const group = groups.get(key) ?? {
        driver: provider.driver,
        identityVerified: verified,
        memberships: [],
      };
      const historyProvider = provider.driver === "claudeAgent" ? "claude" : provider.driver;
      const sources =
        summary?.sources.filter((source) => source.fingerprint.provider === historyProvider) ?? [];
      group.memberships.push({
        isConnected: environment.isConnected,
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        provider,
        historySources: sources.filter((source) =>
          source.configuredInstanceIds?.includes(provider.instanceId),
        ),
        historyMembershipKnown:
          summary != null &&
          sources.length > 0 &&
          sources.every((source) => source.configuredInstanceIds !== undefined),
      });
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const memberships = [...group.memberships].sort(
        (a, b) =>
          b.provider.checkedAt.localeCompare(a.provider.checkedAt) ||
          a.environmentId.localeCompare(b.environmentId) ||
          a.provider.instanceId.localeCompare(b.provider.instanceId),
      );
      const newest = memberships[0];
      const emails = [
        ...new Set(
          memberships.flatMap(({ provider }) =>
            provider.auth.status === "authenticated" && provider.auth.email
              ? [provider.auth.email]
              : [],
          ),
        ),
      ];
      return {
        key,
        driver: group.driver,
        identityVerified: group.identityVerified,
        memberships,
        emails,
        name: newest?.provider.displayName ?? PROVIDER_DISPLAY_NAMES[group.driver] ?? group.driver,
      };
    })
    .sort(
      (a, b) =>
        a.driver.localeCompare(b.driver) ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key),
    );
}

/** Navigation is anchored to a configured instance, so quota/identity refreshes cannot break it. */
export function usageAccountMemberKey(member: UsageAccountMembership): string {
  return JSON.stringify([member.environmentId, member.provider.instanceId]);
}

export function findUsageAccount(
  accounts: readonly UsageAccount[],
  selection: string | null | undefined,
): UsageAccount | undefined {
  return accounts.find((account) =>
    account.memberships.some((member) => usageAccountMemberKey(member) === selection),
  );
}
