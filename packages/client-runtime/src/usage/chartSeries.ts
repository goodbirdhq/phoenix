import type { UsageProviderKind } from "@t3tools/contracts";
import type { EnvironmentUsageBucket } from "@t3tools/shared/usageMerge";
import type { UsageAccount } from "./accounts.ts";

export type UsageChartMetric = "cost" | "tokens";
export type UsageChartGrouping = "provider" | "account" | "environment" | "model";
export interface UsageChartSeries {
  readonly id: string;
  readonly label: string;
  readonly provider: UsageProviderKind;
  readonly values: readonly number[];
}

/** All views consume the same owned buckets, so changing grouping cannot change totals. */
export function usageChartSeries(
  buckets: readonly EnvironmentUsageBucket[],
  accounts: readonly UsageAccount[],
  periods: readonly string[],
  grouping: UsageChartGrouping,
  metric: "cost" | "tokens",
): readonly UsageChartSeries[] {
  const periodIndex = new Map(periods.map((period, index) => [period, index]));
  const accountByMember = new Map(
    accounts.flatMap((account) =>
      account.memberships.map(
        (member) =>
          [JSON.stringify([member.environmentId, member.provider.instanceId]), account] as const,
      ),
    ),
  );
  const series = new Map<
    string,
    { id: string; label: string; provider: UsageProviderKind; values: number[] }
  >();
  for (const entry of buckets) {
    const { bucket } = entry;
    const index = periodIndex.get(bucket.hourStart ?? bucket.day);
    if (index === undefined) continue;
    const candidates = new Set(
      entry.configuredInstanceIds.map((id) =>
        accountByMember.get(JSON.stringify([entry.environmentId, id])),
      ),
    );
    const account =
      entry.configuredInstanceIds.length > 0 && candidates.size === 1
        ? candidates.values().next().value
        : undefined;
    const label =
      grouping === "provider"
        ? bucket.provider
        : grouping === "environment"
          ? entry.environmentLabel
          : grouping === "model"
            ? bucket.model
            : (account?.name ?? `${bucket.provider} · Shared / unassigned`);
    const identity =
      grouping === "provider"
        ? bucket.provider
        : grouping === "environment"
          ? entry.environmentId
          : grouping === "model"
            ? JSON.stringify([bucket.provider, bucket.model])
            : (account?.key ?? `${bucket.provider}:unassigned`);
    let row = series.get(identity);
    if (!row) {
      row = { id: identity, label, provider: bucket.provider, values: periods.map(() => 0) };
      series.set(identity, row);
    }
    const totals = bucket.totals;
    row.values[index]! +=
      metric === "cost"
        ? bucket.costUsd
        : totals.uncachedInputTokens +
          totals.cachedInputTokens +
          totals.cacheCreationTokens +
          totals.outputTokens;
  }
  const ordered = [...series.values()].sort(
    (a, b) =>
      b.values.reduce((sum, value) => sum + value, 0) -
        a.values.reduce((sum, value) => sum + value, 0) || a.id.localeCompare(b.id),
  );
  if (grouping !== "model" || ordered.length <= 8) return ordered;
  const remainder = new Map<UsageProviderKind, UsageChartSeries>();
  for (const row of ordered.slice(5)) {
    const previous = remainder.get(row.provider);
    remainder.set(row.provider, {
      id: `other-models:${row.provider}`,
      label: `Other ${row.provider} models`,
      provider: row.provider,
      values: row.values.map((value, index) => value + (previous?.values[index] ?? 0)),
    });
  }
  return [...ordered.slice(0, 5), ...remainder.values()];
}
