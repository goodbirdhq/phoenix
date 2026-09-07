import { UsageOverview, UsageTotals, UsageMetricToggle } from "./UsageOverview";
import {
  ChartNoAxesColumnIcon,
  BoxIcon,
  FolderIcon,
  MessageSquareIcon,
  ServerIcon,
} from "lucide-react";
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
import { canRefreshProviderAvailability, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatDayShort,
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
import { UsageQuotas } from "./UsageQuotas";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";

export function UsagePage() {
  const { account: accountKey } = useSearch({ from: "/usage" });
  const [pageTab, setPageTab] = useState("overview");
  useEffect(() => setPageTab("overview"), [accountKey]);
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 7,
    window: makeWindow(7),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
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
    { ...window, includeSessions: pageTab === "projects" || pageTab === "sessions" },
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
      includeSessions: pageTab === "projects" || pageTab === "sessions",
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
      <WorkspaceBreadcrumbItem className="hidden md:flex">
        {selectedAccount?.name ?? "All accounts"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );

  return (
    <SidebarInset className="usage-surface h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="max-w-none px-5 pt-7 sm:px-8">
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
                <TabsTrigger value="overview">
                  <ChartNoAxesColumnIcon className="size-3.5" />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="models">
                  <BoxIcon className="size-3.5" />
                  Models
                </TabsTrigger>
                <TabsTrigger value="projects">
                  <FolderIcon className="size-3.5" />
                  Projects
                </TabsTrigger>
                <TabsTrigger value="sessions">
                  <MessageSquareIcon className="size-3.5" />
                  Sessions
                </TabsTrigger>
                {selectedAccount && (
                  <TabsTrigger value="environments">
                    <ServerIcon className="size-3.5" />
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
                    pending={settling}
                  />
                </TabsContent>
              )}
              {(["projects", "sessions"] as const).map((mode) => (
                <TabsContent key={mode} value={mode} className="space-y-6">
                  <UsageTotals merged={merged} pending={settling} windowLabel={windowLabel} />
                  {settling ? (
                    <div
                      className="h-[271px] rounded bg-muted"
                      aria-label="Loading usage chart"
                      role="status"
                    />
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
                      {mode === "projects" && (
                        <div className="flex justify-end">
                          <UsageMetricToggle metric={metric} onChange={setMetric} />
                        </div>
                      )}
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

                <UsageTotals merged={merged} pending={settling} windowLabel={windowLabel} />
                {!hasMappedHistory && !settling && (
                  <p className="text-xs text-muted-foreground">
                    No history can currently be assigned to this account. Shared or unmapped history
                    is available in All accounts.
                  </p>
                )}
                <UsageOverview
                  merged={merged}
                  accounts={accounts}
                  periods={isPast24Hours ? hours : days}
                  metric={metric}
                  onMetricChange={setMetric}
                  timeZone={window.timeZone}
                  models={pageTab === "models"}
                  allAccounts={!selectedAccount}
                  pending={settling}
                />
                <div className="flex justify-between gap-4 text-[11px] leading-4 text-muted-foreground">
                  <span>
                    Cache savings {settling ? "—" : formatUsd(merged.costQuality.cacheSavingsUsd)} ·
                    included in the API estimate
                  </span>
                  <span>
                    {settling
                      ? "Checking usage…"
                      : `${environments.filter((environment) => environment.summary).length} environments reporting`}
                  </span>
                </div>
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />
              </TabsContent>
            </Tabs>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
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
