import { UsageOverview, UsageTotals, UsageMetricToggle } from "./UsageOverview";
import {
  ChartNoAxesColumnIcon,
  BoxIcon,
  FolderIcon,
  GaugeIcon,
  MessageSquareIcon,
  ServerIcon,
} from "lucide-react";
import { UsageReportChart } from "./UsageReportChart";
import { UsageReport } from "./UsageReport";
import { UsageToolbar } from "./UsageToolbar";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { findUsageAccount } from "@t3tools/client-runtime/usage/accounts";
import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { useSearch } from "@tanstack/react-router";
import { PageHeading } from "../patterns/PageHeading";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { Badge } from "../ui/badge";
import { UsageAccountHeader } from "./UsageAccountHeader";
import { UsageEnvironments } from "./UsageEnvironments";
import { useAtomValue } from "@effect/atom-react";
import {
  canRefreshProviderAvailability,
  EnvironmentId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatDayShort,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
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
import { UsageLimitsSection } from "./UsageLimits";
import { UsageQuotas } from "./UsageQuotas";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";
import { METRIC_OPTIONS, resolveUsageShortcut, WINDOW_OPTIONS } from "./usageShortcuts";

const ignoreEscape = () => {};

function isUsageWindowDays(value: number): value is 1 | 7 | 30 | 90 {
  return value === 1 || value === 7 || value === 30 || value === 90;
}

export function UsagePage() {
  const { account: accountKey } = useSearch({ from: "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [pageTab, setPageTab] = useState("overview");
  useEffect(() => setPageTab("overview"), [accountKey]);
  const initialPreferences = useMemo(readUsagePagePreferences, []);
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: initialPreferences.windowDays,
    window: makeWindow(initialPreferences.windowDays),
  }));
  // "limits" only means something for the upstream chart metric toggle; Phoenix
  // surfaces Limits as its own tab, so a saved "limits" preference falls back to
  // the chart's default metric instead.
  const [metric, setMetric] = useState<UsageChartMetric>(
    initialPreferences.metric === "tokens" ? "tokens" : "cost",
  );
  const [historicalEnvironmentId, setHistoricalEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [pricesOpen, setPricesOpen] = useState(false);
  // The model prices dialog owns Escape while it is open.
  useEscapeToGoBack(pricesOpen ? ignoreEscape : undefined);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [isLimitsRefreshing, setIsLimitsRefreshing] = useState(false);
  useEffect(() => {
    if (pageTab === "limits") setLimitsNow(Date.now());
  }, [pageTab]);
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged,
    accounts,
    allEnvironments,
    selectedEnvironments: environments,
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
  const limitsEnvironmentIds = useMemo(() => {
    if (selectedAccount) {
      return new Set(
        selectedAccount.memberships.map((member) => EnvironmentId.make(member.environmentId)),
      );
    }
    return historicalEnvironmentId === null ? null : new Set([historicalEnvironmentId]);
  }, [selectedAccount, historicalEnvironmentId]);
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
    if (!isUsageWindowDays(days)) return;
    const nextWindow = makeWindow(days, undefined, days === 1 ? "hour" : "day");
    setWindowSelection({ days, window: nextWindow });
    saveUsagePagePreferences({ metric, windowDays: days });
  };
  const selectMetric = (nextMetric: UsageChartMetric) => {
    setMetric(nextMetric);
    if (isUsageWindowDays(windowDays)) {
      saveUsagePagePreferences({ metric: nextMetric, windowDays });
    }
  };
  // Provider limit snapshots are what the Limits tab reads. They are refreshed
  // per environment through a shared throttle, so opening the tab repeatedly
  // does not re-probe every provider CLI.
  const refreshLimits = async (automatic = false, afterPending = false) => {
    try {
      await Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (limitsEnvironmentIds !== null && !limitsEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
              afterPending,
            );
          }
        }),
      );
    } finally {
      setLimitsNow(Date.now());
    }
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    refreshCapacity();
    refreshUsage({
      ...nextWindow,
      includeSessions: pageTab === "projects" || pageTab === "sessions",
    });
    setWindowSelection({ days: windowDays, window: nextWindow });
    setLimitsNow(Date.now());
    if (pageTab === "limits" && !isLimitsRefreshing) {
      setIsLimitsRefreshing(true);
      void refreshLimits().finally(() => setIsLimitsRefreshing(false));
    }
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (limitsEnvironmentIds === null || limitsEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  useEffect(() => {
    if (pageTab === "limits" && connectedLimitsEnvironments) autoRefreshLimits();
  }, [pageTab, connectedLimitsEnvironments]);

  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      pricesOpen ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption?.value === "limits") {
      setPageTab("limits");
    } else if (metricOption) {
      selectMetric(metricOption.value);
      // Cost and Tokens have nothing to show on Limits.
      if (pageTab === "limits") setPageTab("overview");
    }
    if (periodOption && pageTab !== "limits") selectWindow(periodOption.days);
  });
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  // A Cursor account only needs this offer on the all-accounts view: Usage
  // accounts are built from subscription drivers, and Cursor history is shared.
  const cursorAccessEnvironments = accountKey
    ? []
    : environments.filter((environment) => environment.needsCursorKeychainAccess);
  const onCursorEnabled = () => {
    refreshUsage();
    void refreshLimits(false, true);
  };
  const sourceMessages = [
    ...new Set(
      environments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !source.action &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
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
      refreshing={isUsageRefreshing || isCapacityRefreshing || isLimitsRefreshing}
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
      onOpenModelPrices={() => setPricesOpen(true)}
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div
        data-usage-surface
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      >
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
                <TabsTrigger value="limits">
                  <GaugeIcon className="size-3.5" />
                  Limits
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
              <TabsContent value="limits">
                <UsageLimitsSection
                  selectedEnvironmentIds={limitsEnvironmentIds}
                  now={limitsNow}
                  cursorPrompt={
                    cursorAccessEnvironments.length > 0 ? (
                      <CursorKeychainPrompt
                        environments={cursorAccessEnvironments}
                        onEnabled={onCursorEnabled}
                      />
                    ) : null
                  }
                />
              </TabsContent>
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
                <TabsContent key={mode} value={mode}>
                  <div className="space-y-6">
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
                          sourceMessages={sourceMessages}
                        />
                        {mode === "projects" && (
                          <div className="flex justify-end">
                            <UsageMetricToggle metric={metric} onChange={selectMetric} />
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
                  </div>
                </TabsContent>
              ))}
              <TabsContent value={pageTab === "models" ? "models" : "overview"}>
                <div className="space-y-6">
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
                  {cursorAccessEnvironments.length > 0 && (
                    <CursorKeychainPrompt
                      environments={cursorAccessEnvironments}
                      onEnabled={onCursorEnabled}
                    />
                  )}
                  {!hasMappedHistory && !settling && (
                    <p className="text-xs text-muted-foreground">
                      No history can currently be assigned to this account. Shared or unmapped
                      history is available in All accounts.
                    </p>
                  )}
                  <UsageOverview
                    merged={merged}
                    accounts={accounts}
                    periods={isPast24Hours ? hours : days}
                    metric={metric}
                    onMetricChange={selectMetric}
                    timeZone={window.timeZone}
                    models={pageTab === "models"}
                    allAccounts={!selectedAccount}
                    pending={settling}
                  />
                  <div className="flex justify-between gap-4 text-2xs text-muted-foreground">
                    <span>
                      Cache savings {settling ? "—" : formatUsd(merged.costQuality.cacheSavingsUsd)}{" "}
                      · included in the API estimate
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
                    sourceMessages={sourceMessages}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </WorkspacePageContainer>
        </ScrollArea>
        {pricesOpen ? (
          <UsagePriceOverrides
            usage={allEnvironments}
            initialSelectedEnvironmentIds={limitsEnvironmentIds}
            onOpenChange={(open) => setPricesOpen(open)}
          />
        ) : null}
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
  sourceMessages,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
  /** Reader messages for partial or failed history sources. */
  readonly sourceMessages: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    sourceMessages.length === 0
  ) {
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
      {sourceMessages.map((message) => (
        <span key={message}>{message}</span>
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

const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

/** Offers the Cursor Keychain opt-in for each environment whose usage reader asked for it. */
function CursorKeychainPrompt({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_KEYCHAIN_COPY}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CursorEnableButton({
  environmentId,
  label,
  buttonText,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly buttonText: string;
  readonly onEnabled: () => void;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: true } },
      });
      if (result._tag === "Success") onEnabled();
    } finally {
      setPending(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </Button>
  );
}
