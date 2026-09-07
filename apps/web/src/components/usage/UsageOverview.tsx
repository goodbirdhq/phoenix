import { usageOverviewRows } from "./usageOverviewRows";
import { useMemo, useState } from "react";
import { ChartNoAxesColumnIcon, CoinsIcon, LayersIcon, SearchIcon } from "lucide-react";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import {
  usageChartSeries,
  type UsageChartMetric,
} from "@t3tools/client-runtime/usage/chart-series";
import {
  formatCount,
  formatTokens,
  formatUsd,
  formatDayShort,
  formatHourShort,
  formatPercent,
} from "@t3tools/shared/usageFormat";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { LineAreaChart } from "../charts/LineAreaChart";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function UsageTotals({
  merged,
  pending,
  windowLabel,
}: {
  readonly merged: MergedUsage;
  readonly pending: boolean;
  readonly windowLabel: string;
}) {
  const metrics = [
    {
      label: "Estimated API cost",
      value: formatUsd(merged.costUsd),
      detail: "API equivalent · not your subscription bill",
      Icon: CoinsIcon,
    },
    {
      label: "Processed tokens",
      value: formatTokens(merged.totalTokens),
      detail: `${formatTokens(merged.cachedInputTokens)} cached · ${formatTokens(merged.uncachedInputTokens + merged.cacheCreationTokens)} input · ${formatTokens(merged.outputTokens)} output`,
      Icon: LayersIcon,
    },
    {
      label: "Sessions",
      value: formatCount(merged.sessions),
      detail: windowLabel,
      Icon: ChartNoAxesColumnIcon,
    },
  ];
  return (
    <section
      aria-label="Usage totals"
      aria-busy={pending}
      className="grid min-h-[113px] grid-cols-1 gap-8 border-b border-border pb-[22px] sm:grid-cols-[1fr_1fr_0.7fr]"
    >
      {metrics.map(({ label, value, detail, Icon }) => (
        <div key={label} className="flex min-w-0 flex-col gap-[7px]">
          <span className="flex items-center gap-[7px] text-[13px] leading-4 text-muted-foreground">
            <Icon className="size-3.5" />
            {label}
          </span>
          <div className="h-11 text-[36px] leading-[44px] font-semibold tracking-[-0.035em] tabular-nums">
            {pending ? <div className="my-1 h-9 w-36 rounded bg-border" /> : value}
          </div>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {pending ? <span className="block h-3 w-44 rounded-sm bg-border" /> : detail}
          </span>
        </div>
      ))}
    </section>
  );
}

export function UsageMetricToggle({
  metric,
  onChange,
}: {
  readonly metric: UsageChartMetric;
  readonly onChange: (value: UsageChartMetric) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Usage metric"
      variant="segmented"
      value={[metric]}
      onValueChange={(values) => {
        const value = values[0];
        if (value === "cost" || value === "tokens") onChange(value);
      }}
    >
      <Toggle value="cost">Cost</Toggle>
      <Toggle value="tokens">Tokens</Toggle>
    </ToggleGroup>
  );
}

export function UsageOverview({
  merged,
  accounts,
  periods,
  metric,
  onMetricChange,
  timeZone,
  models,
  allAccounts,
  pending,
}: {
  readonly merged: MergedUsage;
  readonly accounts: readonly UsageAccount[];
  readonly periods: readonly string[];
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
  readonly timeZone: string;
  readonly models: boolean;
  readonly allAccounts: boolean;
  readonly pending: boolean;
}) {
  const [group, setGroup] = useState("provider");
  const [search, setSearch] = useState("");
  const grouping = models ? "model" : allAccounts && group === "account" ? "account" : "provider";
  const chart = useMemo(
    () => usageChartSeries(merged.buckets, accounts, periods, grouping, metric),
    [merged, accounts, periods, grouping, metric],
  );
  const series = chart.map((row, index) => ({
    ...row,
    label: grouping === "provider" ? PROVIDER_PRESENTATION[row.provider].label : row.label,
    color:
      grouping === "provider"
        ? PROVIDER_PRESENTATION[row.provider].color
        : `color-mix(in srgb, ${PROVIDER_PRESENTATION[row.provider].color} ${100 - (index % 4) * 15}%, var(--background))`,
  }));
  const rows = useMemo(
    () =>
      usageOverviewRows(merged, accounts, periods, grouping, metric).filter((row) =>
        (grouping === "provider" ? PROVIDER_PRESENTATION[row.provider].label : row.label)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [merged, accounts, periods, grouping, metric, search],
  );
  const modelSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of merged.sessionUsage) {
      for (const model of session.models) {
        const key = JSON.stringify([session.provider, model.model]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [merged.sessionUsage]);
  return (
    <>
      <section className="flex flex-col gap-4" aria-busy={pending}>
        <div className="flex min-h-[37px] flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm leading-5 font-semibold">
              {periods[0]?.includes("T") ? "Hourly" : "Daily"} usage{models ? " by model" : ""}
            </h2>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {periods.length
                ? `${formatPeriod(periods[0]!, timeZone)} – ${formatPeriod(periods.at(-1)!, timeZone)}`
                : "Selected period"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <UsageMetricToggle metric={metric} onChange={onMetricChange} />
            {allAccounts && !models && (
              <>
                <span className="text-[11px] text-muted-foreground">Group by</span>
                <ToggleGroup
                  aria-label="Chart breakdown"
                  variant="segmented"
                  value={[group]}
                  onValueChange={(values) => {
                    if (values[0]) setGroup(values[0]);
                  }}
                >
                  <Toggle value="provider">Provider</Toggle>
                  <Toggle value="account">Account</Toggle>
                </ToggleGroup>
              </>
            )}
          </div>
        </div>
        <div className="h-[218px]">
          {pending ? (
            <div
              role="status"
              aria-label="Loading usage chart"
              className="ml-10 h-[196px] rounded bg-muted"
            />
          ) : (
            <LineAreaChart
              periods={periods}
              series={series}
              label={`${grouping} ${metric} over time`}
              format={metric === "cost" ? formatUsd : formatTokens}
              formatPeriod={(period) => formatPeriod(period, timeZone)}
              plotHeight={196}
            />
          )}
        </div>
      </section>
      {(allAccounts || models) && (
        <section className="min-h-[172px]" aria-label="Usage breakdown">
          {models && (
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Usage by model</h2>
              <label className="flex items-center gap-2 rounded-md border px-2 py-1">
                <SearchIcon className="size-3.5 text-muted-foreground" />
                <input
                  aria-label="Search models"
                  placeholder="Search models"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-36 bg-transparent text-xs outline-none"
                />
              </label>
            </div>
          )}
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[14%]" />
              <col className="w-[14%]" />
              <col className="w-[16%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead>
              <tr className="h-[31px] border-b text-left text-[11px] text-muted-foreground">
                <th className="font-medium">
                  {models ? "Model" : grouping === "account" ? "By account" : "By provider"}
                </th>
                <th className="text-right font-normal">Sessions</th>
                <th className="text-right font-normal">Tokens</th>
                <th className="text-right font-normal">API cost</th>
                <th className="text-right font-normal">Cost share</th>
              </tr>
            </thead>
            <tbody>
              {pending ? (
                [0, 1, 2].map((key) => (
                  <tr key={key} className="h-[47px] border-b border-border/50">
                    {[0, 1, 2, 3, 4].map((cell) => (
                      <td key={cell}>
                        <div className="h-2 w-3/4 rounded bg-border" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="h-[141px] text-center text-muted-foreground">
                    {search ? "No matching models" : "No usage reported for this selection"}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const { mark: Mark, color, label } = PROVIDER_PRESENTATION[row.provider];
                  const cost = row.costUsd;
                  const sessions =
                    grouping === "provider"
                      ? merged.providers.find((p) => p.provider === row.provider)?.sessions
                      : grouping === "model"
                        ? merged.sessionDetailUnavailable.length
                          ? undefined
                          : modelSessionCounts.get(JSON.stringify([row.provider, row.label]))
                        : undefined;
                  return (
                    <tr key={row.id} className="h-[47px] border-b border-border/50">
                      <td>
                        <span className="flex items-center gap-2">
                          <Mark className="size-4 shrink-0" />
                          <span className="truncate">
                            {grouping === "provider" ? label : row.label}
                          </span>
                          {grouping === "provider" && (
                            <span className="text-[10px] text-muted-foreground">
                              {(() => {
                                const count = accounts.filter(
                                  (account) =>
                                    (account.driver === "claudeAgent"
                                      ? "claude"
                                      : account.driver) === row.provider,
                                ).length;
                                return `${count} ${count === 1 ? "account" : "accounts"}`;
                              })()}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {sessions === undefined ? "—" : formatCount(sessions)}
                      </td>
                      <td className="text-right tabular-nums">{formatTokens(row.totalTokens)}</td>
                      <td className="text-right font-medium tabular-nums">{formatUsd(cost)}</td>
                      <td className="text-right text-muted-foreground">
                        <span
                          className="inline-block size-[5px] rounded-full"
                          style={{ backgroundColor: color }}
                        />{" "}
                        {formatPercent(merged.costUsd ? cost / merged.costUsd : 0)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function formatPeriod(period: string, timeZone: string) {
  return period.includes("T") ? formatHourShort(period, timeZone) : formatDayShort(period);
}
