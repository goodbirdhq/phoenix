import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import {
  usageChartSeries,
  type UsageChartMetric,
} from "@t3tools/client-runtime/usage/chart-series";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

/** Table rows remain complete even when the chart groups long tails into Other. */
export function usageOverviewRows(
  merged: MergedUsage,
  accounts: readonly UsageAccount[],
  periods: readonly string[],
  grouping: "model" | "provider" | "account",
  metric: UsageChartMetric,
) {
  const models = grouping === "model";
  const costs = models
    ? merged.models.map((row) => ({
        id: JSON.stringify([row.provider, row.model]),
        label: row.model,
        provider: row.provider,
        costUsd: row.costUsd,
        totalTokens: row.totalTokens,
      }))
    : usageChartSeries(merged.buckets, accounts, periods, grouping, "cost").map((row) => ({
        ...row,
        costUsd: row.values.reduce((a, b) => a + b, 0),
        totalTokens: 0,
      }));
  const tokens = models
    ? new Map<string, number>()
    : new Map(
        usageChartSeries(merged.buckets, accounts, periods, grouping, "tokens").map((row) => [
          row.id,
          row.values.reduce((a, b) => a + b, 0),
        ]),
      );
  return costs
    .map((row) => ({ ...row, totalTokens: models ? row.totalTokens : (tokens.get(row.id) ?? 0) }))
    .toSorted((a, b) =>
      metric === "tokens"
        ? b.totalTokens - a.totalTokens || b.costUsd - a.costUsd
        : b.costUsd - a.costUsd || a.id.localeCompare(b.id),
    );
}
