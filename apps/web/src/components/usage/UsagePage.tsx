import { UsageReportChart } from "./UsageReportChart";
import { UsageReport } from "./UsageReport";
import { UsageToolbar } from "./UsageToolbar";
import { findUsageAccount } from "@t3tools/client-runtime/usage/accounts";
import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { useSearch } from "@tanstack/react-router";
import { PageHeading } from "../patterns/PageHeading";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { Badge } from "../ui/badge";
import { UsageAccountHeader } from "./UsageAccountHeader";
import { UsageEnvironments } from "./UsageEnvironments";
import { Metric } from "../patterns/Metric";
import {
  canRefreshProviderAvailability,
  EnvironmentId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import type { UsageChartMetric } from "@t3tools/client-runtime/usage/chart-series";
import { UsageBreakdownChart } from "./UsageBreakdownChart";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import { UsageQuotas } from "./UsageQuotas";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";

export function UsagePage() {
  const { account: accountKey } = useSearch({ from: "/usage" });
  const [pageTab, setPageTab] = useState("overview");
  useEffect(() => setPageTab("overview"), [accountKey]);
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const breakdown = pageTab === "models" ? "model" : "time";
  const [historicalEnvironmentId, setHistoricalEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged,
    accounts,
    allEnvironments,
    environments,
    isPending,
    isPartial,
    isUsageRefreshing,
    refreshUsage,
    refreshCapacity,
    providerAvailability,
    isProviderAvailabilityPending,
    isCapacityRefreshing,
  } = useUsage(
    { ...window, includeSessions: pageTab === "projects" || pageTab === "threads" },
    historicalEnvironmentId,
    accountKey ?? null,
  );
  const selectedAccount = findUsageAccount(accounts, accountKey);
  const hasMappedHistory = useMemo(
    () =>
      !accountKey ||
      (selectedAccount &&
        environments.some(
          (environment) =>
            environment.summary &&
            scopeAccountHistory(environment.summary, environment.environmentId, selectedAccount)
              .sources.length > 0,
        )),
    [accountKey, selectedAccount, environments],
  );
  const updateCount =
    selectedAccount?.memberships.filter(
      (member) => member.provider.versionAdvisory?.status === "behind_latest",
    ).length ?? 0;
  const capacitySources = useMemo(
    () =>
      subscriptionAvailabilitySources(providerAvailability).filter(
        (source) =>
          !accountKey ||
          selectedAccount?.memberships.some(
            (member) =>
              member.environmentId === source.environmentId &&
              member.provider.instanceId === source.instanceId,
          ),
      ),
    [providerAvailability, accountKey, selectedAccount],
  );

  useEffect(() => {
    if (
      historicalEnvironmentId !== null &&
      !allEnvironments.some((environment) => environment.environmentId === historicalEnvironmentId)
    ) {
      setHistoricalEnvironmentId(null);
    }
  }, [allEnvironments, historicalEnvironmentId]);

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const accountPending = Boolean(accountKey) && !selectedAccount && isProviderAvailabilityPending;
  const settling = isPending || isPartial || accountPending;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? merged.models.toSorted(
            (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
          )
        : merged.models,
    [breakdown, merged.models, metric],
  );
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    refreshCapacity();
    refreshUsage({
      ...nextWindow,
      includeSessions: pageTab === "projects" || pageTab === "threads",
    });
    setWindowSelection({ days: windowDays, window: nextWindow });
  };
  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const toolbar = (
    <UsageToolbar
      environments={allEnvironments}
      environmentId={historicalEnvironmentId}
      onEnvironmentChange={setHistoricalEnvironmentId}
      metric={metric}
      onMetricChange={setMetric}
      days={windowDays}
      onDaysChange={selectWindow}
      refreshing={isUsageRefreshing || isCapacityRefreshing}
      confirmed={
        !environments.some((environment) => environment.error) &&
        !providerAvailability.some(
          (environment) =>
            environment.hasError ||
            (environment.isConnected &&
              environment.providers.some(
                (entry) =>
                  environment.serverProviders?.some(
                    (provider) =>
                      provider.instanceId === entry.instanceId &&
                      canRefreshProviderAvailability(provider),
                  ) &&
                  entry.availability.source !== "unsupported" &&
                  (entry.availability.status === "unknown" || entry.availability.stale),
              )),
        )
      }
      onRefresh={refreshWindow}
    />
  );
  const topbarContent = (
    <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
      <WorkspaceBreadcrumbItem current>Usage</WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
      <WorkspaceBreadcrumbItem className="hidden md:flex">{windowLabel}</WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {selectedAccount ? (
              <UsageAccountHeader
                key={selectedAccount.key}
                account={selectedAccount}
                actions={toolbar}
              />
            ) : (
              <PageHeading
                actions={toolbar}
                title={
                  accountKey
                    ? accountPending
                      ? "Loading account…"
                      : "Account unavailable"
                    : "All accounts"
                }
                description={
                  accountKey
                    ? accountPending
                      ? "Checking configured accounts…"
                      : "This account is no longer available. Select an account from the sidebar."
                    : `${accounts.length} configured accounts · ${allEnvironments.length} ${allEnvironments.length === 1 ? "environment" : "environments"}`
                }
              />
            )}
            <Tabs
              value={pageTab}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  setPageTab(value);
                }
              }}
            >
              <TabsList aria-label="Usage views">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="models">Models</TabsTrigger>
                <TabsTrigger value="projects">Projects</TabsTrigger>
                <TabsTrigger value="threads">Threads</TabsTrigger>
                {selectedAccount && (
                  <TabsTrigger value="environments">
                    Environments
                    {updateCount > 0 && (
                      <Badge variant="warning">
                        {updateCount} update{updateCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </TabsTrigger>
                )}
              </TabsList>
              {selectedAccount && (
                <TabsContent value="environments">
                  <UsageEnvironments
                    account={selectedAccount}
                    environmentId={historicalEnvironmentId}
                    merged={merged}
                    timeZone={window.timeZone}
                  />
                </TabsContent>
              )}
              {(["projects", "threads"] as const).map((mode) => (
                <TabsContent key={mode} value={mode} className="space-y-6">
                  {settling ? (
                    <UsageSkeleton />
                  ) : !hasMappedHistory ? (
                    <p className="py-8 text-sm text-muted-foreground">
                      No history can currently be assigned to this account. Shared or unmapped
                      history is available in All accounts.
                    </p>
                  ) : (
                    <>
                      <UsageCoverageNotice
                        environments={environments}
                        duplicateSources={merged.duplicateSources}
                        staleEnvironments={merged.staleEnvironments}
                      />
                      <UsageReportChart
                        mode={mode}
                        merged={merged}
                        periods={isPast24Hours ? hours : days}
                        metric={metric}
                        accounts={accounts}
                        timeZone={window.timeZone}
                        accountDriver={selectedAccount?.driver}
                        allAccounts={!selectedAccount}
                      />
                      <UsageReport mode={mode} merged={merged} />
                    </>
                  )}
                </TabsContent>
              ))}
              <TabsContent
                value={pageTab === "models" ? "models" : "overview"}
                className="space-y-6"
              >
                {selectedAccount && (
                  <p className="text-xs text-muted-foreground">
                    History from this account’s linked stores. Shared and unmapped history remains
                    in All accounts; these totals do not prove which login produced older records.
                  </p>
                )}
                {selectedAccount && (
                  <UsageQuotas
                    driver={selectedAccount.driver}
                    sources={capacitySources}
                    isPending={isProviderAvailabilityPending}
                    key={selectedAccount.key}
                    refreshFailed={selectedAccount.memberships.some((member) =>
                      providerAvailability.some(
                        (environment) =>
                          environment.environmentId === member.environmentId &&
                          (!environment.isConnected || environment.hasError),
                      ),
                    )}
                    connected={selectedAccount.memberships.some((member) =>
                      providerAvailability.some(
                        (environment) =>
                          environment.environmentId === member.environmentId &&
                          environment.isConnected,
                      ),
                    )}
                    isRefreshing={selectedAccount.memberships.some((member) =>
                      providerAvailability.some(
                        (environment) =>
                          environment.environmentId === member.environmentId &&
                          environment.refreshingInstanceIds.includes(member.provider.instanceId),
                      ),
                    )}
                    onRefresh={() =>
                      refreshCapacity(
                        selectedAccount.memberships.map((member) => ({
                          environmentId: EnvironmentId.make(member.environmentId),
                          instanceId: member.provider.instanceId,
                        })),
                      )
                    }
                  />
                )}

                {settling ? (
                  <>
                    {environments.length > 1 ? (
                      <UsageDeviceStrip environments={environments} />
                    ) : null}
                    <UsageSkeleton />
                  </>
                ) : !hasMappedHistory ? (
                  <p className="py-8 text-sm text-muted-foreground">
                    No history can currently be assigned to this account. Shared or unmapped history
                    is available in All accounts.
                  </p>
                ) : (
                  <>
                    <UsageCoverageNotice
                      environments={environments}
                      duplicateSources={merged.duplicateSources}
                      staleEnvironments={merged.staleEnvironments}
                    />

                    <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                      <div className="flex min-w-0 flex-col gap-5">
                        <div className="flex flex-col gap-1">
                          <span className="text-4xl font-semibold text-foreground tabular-nums">
                            {metric === "cost"
                              ? formatUsd(merged.costUsd)
                              : formatTokens(merged.totalTokens)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${formatCount(merged.sessions)} sessions · API estimate`
                              : `${formatCount(merged.sessions)} sessions`}
                          </span>
                        </div>

                        {activeProviders.map((provider) => {
                          const totals = merged.providers.find(
                            (entry) => entry.provider === provider,
                          );
                          const share =
                            metric === "cost"
                              ? (totals?.costShare ?? 0)
                              : (totals?.tokenShare ?? 0);
                          const providerSessions = totals?.sessions ?? 0;
                          const sessionLabel = `${formatCount(providerSessions)} ${
                            providerSessions === 1 ? "session" : "sessions"
                          }`;
                          return (
                            <div key={provider} className="flex flex-col gap-1">
                              <div className="flex items-baseline justify-between gap-4">
                                <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                                  <span
                                    aria-hidden
                                    className="size-2 shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                    }}
                                  />
                                  <ProviderMark provider={provider} className="size-4" />
                                  <span className="flex min-w-0 items-baseline gap-1.5">
                                    <span className="truncate">
                                      {PROVIDER_PRESENTATION[provider].label}
                                    </span>
                                    <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                                      {sessionLabel}
                                    </span>
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                                  {metric === "cost"
                                    ? formatUsd(totals?.costUsd ?? 0)
                                    : formatTokens(totals?.totalTokens ?? 0)}
                                </span>
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {metric === "cost"
                                  ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                                  : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="flex min-w-0 flex-col gap-3">
                        <h2 className="text-sm font-medium text-foreground">
                          {isPast24Hours ? "Hourly" : "Daily"}{" "}
                          {metric === "tokens" ? "processed tokens" : "cost"}
                        </h2>
                        <UsageBreakdownChart
                          merged={merged}
                          accounts={accounts}
                          periods={isPast24Hours ? hours : days}
                          metric={metric}
                          timeZone={window.timeZone}
                          grouping={pageTab === "models" ? "model" : "provider"}
                          allowAccounts={!selectedAccount}
                        />
                      </div>
                    </section>

                    <section className="flex flex-col gap-2">
                      <h2 className="text-sm font-medium text-foreground">Totals</h2>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                        <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                        <Metric
                          label="Cached input"
                          value={formatTokens(merged.cachedInputTokens)}
                        />
                        <Metric
                          label="Uncached input"
                          value={formatTokens(merged.uncachedInputTokens)}
                        />
                        <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                        <Metric
                          label="Cache savings"
                          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                        />
                      </div>
                    </section>

                    <section className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-sm font-medium text-foreground">
                          {pageTab === "models" ? "Models" : "Activity"}
                        </h2>
                      </div>

                      {breakdown === "model" ? (
                        <table className="w-full table-fixed text-sm">
                          <colgroup>
                            <col className="w-2/5" />
                            <col className="w-1/5" />
                            <col className="w-1/5" />
                            <col className="w-1/5" />
                          </colgroup>
                          <thead>
                            <tr className="border-b border-border text-left text-xs text-muted-foreground">
                              <th className="py-2 font-normal">Model</th>
                              <th className="py-2 text-right font-normal">Cost</th>
                              <th className="py-2 text-right font-normal">Share</th>
                              <th className="py-2 text-right font-normal">Tokens</th>
                            </tr>
                          </thead>
                          <tbody>
                            {breakdownModels.length === 0 ? (
                              <tr>
                                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                                  No activity in this window.
                                </td>
                              </tr>
                            ) : (
                              breakdownModels.map((model) => (
                                <tr
                                  key={`${model.provider}:${model.model}`}
                                  className="border-b border-border/50 transition-colors hover:bg-muted/50"
                                >
                                  <td className="py-2 text-foreground">
                                    <span className="flex items-center gap-2">
                                      <ProviderMark
                                        provider={model.provider}
                                        className="size-3.5"
                                      />
                                      {model.model}
                                    </span>
                                  </td>
                                  <td className="py-2 text-right text-foreground tabular-nums">
                                    {formatUsd(model.costUsd)}
                                  </td>
                                  <td className="py-2 text-right text-muted-foreground tabular-nums">
                                    {formatPercent(model.costShare)}
                                  </td>
                                  <td className="py-2 text-right text-muted-foreground tabular-nums">
                                    {formatTokens(model.totalTokens)}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      ) : (
                        <table className="w-full table-fixed text-sm">
                          <colgroup>
                            <col className="w-2/5" />
                            {activeProviders.map((provider) => (
                              <col key={provider} style={{ width: timeValueColumnWidth }} />
                            ))}
                            <col style={{ width: timeValueColumnWidth }} />
                            <col style={{ width: timeValueColumnWidth }} />
                          </colgroup>
                          <thead>
                            <tr className="border-b border-border text-left text-xs text-muted-foreground">
                              <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                              {activeProviders.map((provider) => (
                                <th key={provider} className="py-2 text-right font-normal">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </th>
                              ))}
                              <th className="py-2 text-right font-normal">Total</th>
                              <th className="py-2 text-right font-normal">Tokens</th>
                            </tr>
                          </thead>
                          <tbody>
                            {breakdownPeriods.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={activeProviders.length + 3}
                                  className="py-6 text-center text-muted-foreground"
                                >
                                  No activity in this window.
                                </td>
                              </tr>
                            ) : (
                              breakdownPeriods.map((period) => (
                                <tr
                                  key={"hourStart" in period ? period.hourStart : period.day}
                                  className="border-b border-border/50 transition-colors hover:bg-muted/50"
                                >
                                  <td className="py-2 text-foreground">
                                    {"hourStart" in period
                                      ? formatHourShort(period.hourStart, window.timeZone)
                                      : formatDayShort(period.day)}
                                  </td>
                                  {activeProviders.map((provider) => (
                                    <td
                                      key={provider}
                                      className="py-2 text-right text-muted-foreground tabular-nums"
                                    >
                                      {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                    </td>
                                  ))}
                                  <td className="py-2 text-right text-foreground tabular-nums">
                                    {formatUsd(period.costUsd)}
                                  </td>
                                  <td className="py-2 text-right text-muted-foreground tabular-nums">
                                    {formatTokens(period.totalTokens)}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      )}
                    </section>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

/**
 * Says plainly when the totals are incomplete: an environment that failed, or
 * one whose transcripts another environment already reported. Environments
 * that are still answering never reach this notice; the page shows the
 * loading skeleton until every one is terminal.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">
        {scanning.length === 1
          ? "1 device still scanning"
          : `${scanning.length} devices still scanning`}
      </span>
    </div>
  );
}

/**
 * Static stand-in with the loaded page's shape. No shimmer; blocks fill in
 * exactly once when the last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="h-10 w-36 rounded-sm bg-muted" />
            <div className="h-4 w-32 rounded-sm bg-muted" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full bg-muted" />
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <div className="h-3.5 w-20 rounded-sm bg-muted" />
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-4 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="h-5 w-24 rounded-sm bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="ml-16 h-56 rounded-sm bg-muted/35" />
            <div className="ml-16 h-4 rounded-sm bg-muted/35" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"].map(
            (label) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="h-6 w-16 rounded-sm bg-muted" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Activity</h2>
          <div className="h-7 w-28 rounded-lg bg-input/40" />
        </div>
        <div className="h-44 rounded-sm bg-muted/35" />
      </section>
    </>
  );
}
