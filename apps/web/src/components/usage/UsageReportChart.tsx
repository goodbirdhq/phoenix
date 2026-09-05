import { usageReportSeries } from "@t3tools/client-runtime/usage/report-chart-series";
import { useMemo, useState } from "react";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import {
  formatDayShort,
  formatHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { LineAreaChart } from "../charts/LineAreaChart";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { Button } from "../ui/button";

export function UsageReportChart({
  mode,
  merged,
  periods,
  metric,
  accounts,
  timeZone,
  allAccounts,
  accountDriver,
}: {
  readonly mode: "projects" | "threads";
  readonly merged: MergedUsage;
  readonly periods: readonly string[];
  readonly metric: "cost" | "tokens";
  readonly accounts: readonly UsageAccount[];
  readonly timeZone: string;
  readonly allAccounts: boolean;
  readonly accountDriver?: string | undefined;
}) {
  const [byProvider, setByProvider] = useState(false);
  const series = useMemo(
    () =>
      usageReportSeries(
        merged,
        accounts,
        periods,
        mode,
        metric,
        timeZone,
        allAccounts && byProvider,
      ).map((row, index) => {
        const kind = row.provider ?? (accountDriver === "claudeAgent" ? "claude" : accountDriver);
        const presentation =
          kind === "claude" || kind === "codex" || kind === "grok" || kind === "opencode"
            ? PROVIDER_PRESENTATION[kind]
            : undefined;
        return {
          ...row,
          color:
            mode === "projects"
              ? allAccounts
                ? ["var(--primary)", "#d97757", "#6366f1", "#0891b2", "#16a34a"][index % 5]!
                : `color-mix(in srgb, ${presentation?.color ?? "var(--primary)"} ${100 - (index % 4) * 18}%, var(--background))`
              : (presentation?.color ?? "var(--primary)"),
          label:
            mode === "threads" && allAccounts && byProvider
              ? (presentation?.label ?? row.label)
              : row.label,
        };
      }),
    [merged, accounts, periods, mode, metric, timeZone, allAccounts, byProvider, accountDriver],
  );
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {mode === "threads"
            ? "Sessions created"
            : `Project ${metric === "cost" ? "cost" : "tokens"}`}
        </h2>
        {mode === "threads" && allAccounts && (
          <div role="group" aria-label="Session chart breakdown">
            <Button
              variant={!byProvider ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={!byProvider}
              onClick={() => setByProvider(false)}
            >
              Total
            </Button>
            <Button
              variant={byProvider ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={byProvider}
              onClick={() => setByProvider(true)}
            >
              By provider
            </Button>
          </div>
        )}
      </div>
      {mode === "threads" && merged.threadCreationReporting === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          Session creation history is not available from these environments.
        </p>
      )}
      <LineAreaChart
        periods={periods}
        series={series}
        label={mode === "threads" ? "Sessions created over time" : "Project usage over time"}
        format={
          mode === "threads"
            ? (value) => value.toLocaleString()
            : metric === "cost"
              ? formatUsd
              : formatTokens
        }
        formatPeriod={(period) =>
          period.includes("T") ? formatHourShort(period, timeZone) : formatDayShort(period)
        }
      />
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {series.map((row) => (
          <span key={row.id} className="flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ backgroundColor: row.color }} />
            {row.label}
          </span>
        ))}
      </div>
      {mode === "projects" &&
        merged.sessionUsage.some((session) => session.periods === undefined) && (
          <p className="text-xs text-muted-foreground">
            Some older environments cannot provide project trends.
          </p>
        )}
      {mode === "threads" && (
        <p className="text-xs text-muted-foreground">
          Phoenix threads created during this period, including threads without token usage.
        </p>
      )}
    </section>
  );
}
