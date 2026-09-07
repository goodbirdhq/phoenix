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
import { Toggle, ToggleGroup } from "../ui/toggle-group";

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
  readonly mode: "projects" | "sessions";
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
            mode === "sessions" && allAccounts && byProvider
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
          {mode === "sessions"
            ? "Active sessions"
            : `Project ${metric === "cost" ? "cost" : "tokens"}`}
        </h2>
        {mode === "sessions" && allAccounts && (
          <ToggleGroup
            aria-label="Session chart breakdown"
            variant="segmented"
            value={[byProvider ? "provider" : "total"]}
            onValueChange={(values) => {
              if (values[0]) setByProvider(values[0] === "provider");
            }}
          >
            <Toggle value="total">Total</Toggle>
            <Toggle value="provider">By provider</Toggle>
          </ToggleGroup>
        )}
      </div>
      {mode === "sessions" &&
        (merged.sessionDetailUnavailable.length > 0 ||
          merged.sessionUsage.some((session) => session.periods === undefined)) && (
          <p role="status" className="text-xs text-muted-foreground">
            Some environments cannot report session activity detail. Their totals remain in
            Overview.
          </p>
        )}
      <LineAreaChart
        periods={periods}
        series={series}
        plotHeight={196}
        label={mode === "sessions" ? "Active sessions over time" : "Project usage over time"}
        format={
          mode === "sessions"
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
      {mode === "sessions" && (
        <p className="text-xs text-muted-foreground">
          Provider sessions with activity in each interval. A session active on multiple days
          appears on each day; these are not conversation creation counts.
        </p>
      )}
    </section>
  );
}
