import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import {
  usageChartSeries,
  type UsageChartMetric,
} from "@t3tools/client-runtime/usage/chart-series";
import { isModelCostUnknown, type MergedUsage } from "@t3tools/shared/usageMerge";

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
        unpricedRecords: row.unpricedRecords,
        costUnknown: isModelCostUnknown(row),
      }))
    : usageChartSeries(merged.buckets, accounts, periods, grouping, "cost").map((seriesRow) => {
        const unpricedRecords = seriesRow.unpricedRecords;
        return {
          id: seriesRow.id,
          label: seriesRow.label,
          provider: seriesRow.provider,
          costUsd: seriesRow.values.reduce((a, b) => a + b, 0),
          totalTokens: 0,
          unpricedRecords,
          costUnknown: seriesRow.records > 0 && unpricedRecords >= seriesRow.records,
        };
      });
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
