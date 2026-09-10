import { useMemo, useState } from "react";
import {
  usageChartSeries,
  type UsageChartGrouping,
} from "@t3tools/client-runtime/usage/chart-series";
import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import {
  formatTokens,
  formatUsd,
  formatDayShort,
  formatHourShort,
} from "@t3tools/shared/usageFormat";
import { LineAreaChart } from "../charts/LineAreaChart";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { Button } from "../ui/button";

export function UsageBreakdownChart({
  merged,
  accounts,
  periods,
  metric,
  timeZone,
  grouping = "provider",
  allowAccounts,
}: {
  readonly merged: MergedUsage;
  readonly accounts: readonly UsageAccount[];
  readonly periods: readonly string[];
  readonly metric: "cost" | "tokens";
  readonly timeZone: string;
  readonly grouping?: UsageChartGrouping;
  readonly allowAccounts: boolean;
}) {
  const [selection, setSelection] = useState<UsageChartGrouping>(grouping);
  const active =
    grouping === "model"
      ? "model"
      : selection === "account" && !allowAccounts
        ? "provider"
        : selection;
  const rows = useMemo(
    () => usageChartSeries(merged.buckets, accounts, periods, active, metric),
    [merged.buckets, accounts, periods, active, metric],
  );
  const series = rows.map((row, index) => {
    const { color, label, mark: Mark } = PROVIDER_PRESENTATION[row.provider];
    return {
      ...row,
      label: active === "provider" ? label : row.label,
      icon: <Mark className="size-3" />,
      color:
        active === "provider"
          ? color
          : `color-mix(in srgb, ${color} ${100 - (index % 4) * 15}%, var(--background))`,
    };
  });
  return (
    <div className="space-y-3">
      {grouping !== "model" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Chart breakdown">
          {(["provider", ...(allowAccounts ? ["account"] : []), "environment"] as const).map(
            (value) => (
              <Button
                key={value}
                variant={active === value ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={active === value}
                onClick={() => setSelection(value as UsageChartGrouping)}
              >
                {value === "provider"
                  ? "By provider"
                  : value === "account"
                    ? "By account"
                    : "By environment"}
              </Button>
            ),
          )}
        </div>
      )}
      <LineAreaChart
        periods={periods}
        series={series}
        label={`${active} ${metric} over time`}
        format={metric === "cost" ? formatUsd : formatTokens}
        formatPeriod={(period) =>
          period.includes("T") ? formatHourShort(period, timeZone) : formatDayShort(period)
        }
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((row) => (
          <span key={row.id} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: row.color }} />
            {row.label}
          </span>
        ))}
      </div>
    </div>
  );
}
