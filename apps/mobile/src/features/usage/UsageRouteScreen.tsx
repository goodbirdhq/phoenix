import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { UsageReport } from "./UsageReport";
import {
  usageChartSeries,
  type UsageChartGrouping,
} from "@t3tools/client-runtime/usage/chart-series";
import { usageReportSeries } from "@t3tools/client-runtime/usage/report-chart-series";
import { findUsageAccount, usageAccountMemberKey } from "@t3tools/client-runtime/usage/accounts";
import { type RouteProp, useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionLimitResetLabel,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
  type SubscriptionLimit,
} from "@t3tools/client-runtime/usage/subscription-availability";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import {
  enumerateDays,
  enumerateHourStarts,
  formatPercent,
  formatTokens,
  formatUsd,
  formatDateTimeShort,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/SegmentedControl";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { LineAreaChart } from "../../components/charts/LineAreaChart";
import type { UsageChartMetric } from "@t3tools/client-runtime/usage/chart-series";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

// Labels are abbreviated to share a row with the metric toggle; screen
// readers get the full phrase.
const WINDOW_OPTIONS = [
  { value: 1, label: "24h", accessibilityLabel: "Past 24 hours" },
  { value: 7, label: "7d", accessibilityLabel: "Past 7 days" },
  { value: 30, label: "30d", accessibilityLabel: "Past 30 days" },
  { value: 90, label: "90d", accessibilityLabel: "Past 90 days" },
] as const;

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const satisfies readonly { value: UsageChartMetric; label: string }[];

const CHART_HEIGHT = 180;
const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const unavailable = props.environments.filter((environment) => environment.error !== null);
  const pending = props.environments.filter((environment) => environment.isPending);
  if (!props.isPartial && unavailable.length === 0 && pending.length === 0) return null;
  const label =
    unavailable.length > 0
      ? `Usage is incomplete: ${unavailable.map((environment) => environment.label).join(", ")} could not be read.`
      : pending.length > 0
        ? "Refreshing usage from connected environments…"
        : "Usage is incomplete for one or more environments.";
  return <Text className="text-xs text-foreground-muted">{label}</Text>;
}

/**
 * Two tabs over one screen. Usage is the transcript-derived spend for a
 * period; Limits is the live subscription quota, which has no period. Both
 * pull to refresh, each refreshing its own data.
 */
export function UsageRouteScreen() {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Overview is the default; Limits stays a tap away, unless a widget or other
  // explicit navigation link asks for it by name.
  const [selection, setSelection] = useState(() => ({
    params: route.params,
    tab: route.params?.tab === "limits" ? "limits" : "overview",
  }));
  if (selection.params !== route.params) {
    setSelection({
      params: route.params,
      tab: route.params?.tab === "limits" ? "limits" : "overview",
    });
  }
  const { tab } = selection;
  const setTab = (tab: string) => setSelection({ params: route.params, tab });
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<UsageChartGrouping>("provider");
  const [threadByProvider, setThreadByProvider] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
    setTab("overview");
  }, [accountKey]);
  const colors = useProviderColors();
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  // The account view scopes history to one environment at a time; the Limits
  // tab pools across the (possibly multiple) environments chosen there.
  const accountScopedEnvironmentIds = useMemo(
    () => (environmentId === null ? null : new Set([EnvironmentId.make(environmentId)])),
    [environmentId],
  );
  const {
    merged,
    accounts,
    allEnvironments,
    environments,
    selectedEnvironments,
    isPending,
    isPartial,
    refresh,
    providerAvailability,
    isProviderAvailabilityPending,
    hasProviderAvailabilityError,
  } = useUsage(
    { ...window, includeSessions: tab === "projects" || tab === "threads" },
    accountScopedEnvironmentIds,
    accountKey,
  );
  const isFocused = useIsFocused();
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && tab === "limits");
  const selectedAccount = findUsageAccount(accounts, accountKey);
  const hasMappedHistory = useMemo(
    () =>
      !accountKey ||
      (selectedAccount &&
        selectedEnvironments.some(
          (environment) =>
            environment.summary &&
            scopeAccountHistory(environment.summary, environment.environmentId, selectedAccount)
              .sources.length > 0,
        )),
    [accountKey, selectedAccount, selectedEnvironments],
  );
  const subscriptionLimits = useMemo(
    () =>
      deriveSubscriptionLimits(
        providerAvailability.flatMap((environment) =>
          environment.providers
            .filter(
              (entry) =>
                !selectedAccount ||
                selectedAccount.memberships.some(
                  (member) =>
                    member.environmentId === environment.environmentId &&
                    member.provider.instanceId === entry.instanceId,
                ),
            )
            .map((entry) => {
              const provider = environment.serverProviders?.find(
                (candidate) => candidate.instanceId === entry.instanceId,
              );
              return {
                environmentId: environment.environmentId,
                environmentLabel: environment.label,
                instanceId: entry.instanceId,
                driver: entry.driver,
                displayName:
                  entry.displayName ??
                  provider?.displayName ??
                  providerLimitSourceName(entry.driver),
                ...(provider?.accentColor ? { accentColor: provider.accentColor } : {}),
                enabled: provider?.enabled === true,
                authenticated: provider?.auth.status === "authenticated",
                availability: entry.availability,
              } satisfies SubscriptionAvailabilitySource;
            }),
        ),
      ),
    [providerAvailability, selectedAccount],
  );
  const resetClockMs = useMinuteClock(
    subscriptionLimits.some((limit) =>
      limit.availability.windows.some((window) => window.resetsAt !== undefined),
    ),
  );
  const cursorAccessEnvironments = selectedEnvironments.filter(
    (environment) => environment.needsCursorKeychainAccess,
  );
  const refreshAfterCursorEnable = () => {
    void refresh();
    void limits.refreshAfterEnable();
  };
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
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

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const chartDays = useMemo(
    () =>
      isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
        ? enumerateHourStarts(window.sinceTime, window.untilTime)
        : days,
    [days, isPast24Hours, window.sinceTime, window.untilTime],
  );
  const chartRows = useMemo(() => {
    const rows =
      tab === "projects" || tab === "threads"
        ? usageReportSeries(
            merged,
            accounts,
            chartDays,
            tab,
            metric,
            window.timeZone,
            !selectedAccount && threadByProvider,
          )
        : usageChartSeries(
            merged.buckets,
            accounts,
            chartDays,
            tab === "models" ? "model" : grouping,
            metric,
          );
    return rows.map((row) => ({
      ...row,
      color:
        row.provider === "claude" ||
        row.provider === "codex" ||
        row.provider === "grok" ||
        row.provider === "opencode"
          ? colors[row.provider]
          : selectedAccount?.driver === "claudeAgent"
            ? colors.claude
            : selectedAccount?.driver === "grok"
              ? colors.grok
              : selectedAccount?.driver === "opencode"
                ? colors.opencode
                : colors.codex,
    }));
  }, [
    merged,
    accounts,
    chartDays,
    tab,
    metric,
    window.timeZone,
    grouping,
    colors,
    selectedAccount,
    threadByProvider,
  ]);

  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const showingLimits = tab === "limits";
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    if (refreshingRef.current) return;
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
    refreshingRef.current = true;
    setRefreshingUsage(true);
    void refresh({
      ...nextWindow,
      includeSessions: tab === "projects" || tab === "threads",
    }).finally(() => {
      refreshingRef.current = false;
      setRefreshingUsage(false);
    });
  };

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const hasLoadingEnvironments = selectedEnvironments.some(isUsageLoading);
  const filterAccessibilityLabel = hasLoadingEnvironments
    ? "Filter usage environments, some environments are loading"
    : "Filter usage environments";
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = useMemo(
    () => [
      {
        id: "all",
        title: "All environments",
        subtitle: undefined,
        state: selectedEnvironmentIds === null ? ("on" as const) : ("off" as const),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: usageEnvironmentStatus(environment),
        state:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)
            ? ("on" as const)
            : ("off" as const),
      })),
    ],
    [environments, selectedEnvironmentIds],
  );
  const selectEnvironment = useCallback(
    (value: string) => {
      if (value === "all") {
        setSelectedEnvironmentIds(null);
        return;
      }
      const id = EnvironmentId.make(value);
      setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
    },
    [environments],
  );
  const environmentFilter = useMemo(
    () =>
      showEnvironmentFilter ? (
        <ControlPillMenu
          accessible
          accessibilityRole="button"
          accessibilityLabel={filterAccessibilityLabel}
          title="Environments"
          actions={environmentActions}
          onPressAction={({ nativeEvent }) => selectEnvironment(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filterAccessibilityLabel}
            className={cn(
              "items-center justify-center rounded-full",
              Platform.OS === "ios" ? "size-[28px]" : "size-[44px]",
            )}
          >
            <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
            {hasLoadingEnvironments ? (
              <View
                pointerEvents="none"
                className="absolute -right-[2px] -top-[2px] size-[9px] rounded-full bg-amber-500"
              />
            ) : null}
          </Pressable>
        </ControlPillMenu>
      ) : null,
    [
      showEnvironmentFilter,
      environmentActions,
      selectEnvironment,
      filterAccessibilityLabel,
      filterIcon,
      hasLoadingEnvironments,
    ],
  );

  useLayoutEffect(() => {
    if (Platform.OS === "ios") {
      navigation.setOptions({ headerRight: () => environmentFilter });
    }
  }, [navigation, environmentFilter]);

  return (
    <SettingsScreen title="Usage" trailing={environmentFilter}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={showingLimits ? limits.refreshing : refreshingUsage}
            onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
          />
        }
      >
        <Text className="text-xs text-foreground-muted">Accounts</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {[
              { key: null, name: "All accounts", selected: accountKey === null },
              ...accounts.map((account) => ({
                key: account.memberships[0]
                  ? usageAccountMemberKey(account.memberships[0])
                  : account.key,
                name: account.name,
                selected: selectedAccount?.key === account.key,
              })),
            ].map((account) => (
              <Pressable
                key={account.key ?? "all"}
                accessibilityRole="button"
                accessibilityState={{ selected: account.selected }}
                onPress={() => setAccountKey(account.key)}
                className={
                  account.selected ? "rounded-lg bg-subtle-strong p-3" : "rounded-lg bg-card p-3"
                }
              >
                <Text className="text-sm text-foreground">{account.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        {selectedAccount && (
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <ProviderIcon provider={selectedAccount.driver} size={24} />
              <Text className="text-xl font-t3-medium text-foreground">{selectedAccount.name}</Text>
            </View>
            {selectedAccount.emails.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={revealed ? "Hide email" : "Reveal email"}
                onPress={() => setRevealed(!revealed)}
              >
                <Text className="text-sm text-foreground-muted">
                  {revealed ? selectedAccount.emails.join(", ") : "•••••••• · Tap to reveal"}
                </Text>
              </Pressable>
            )}
            <Text className="text-xs text-foreground-muted">
              {selectedAccount.memberships[0]?.provider.auth.label}
            </Text>
          </View>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {[
              { id: null, label: "All environments" },
              ...allEnvironments.map((environment) => ({
                id: String(environment.environmentId),
                label: environment.label,
              })),
            ].map((environment) => (
              <Pressable
                key={environment.id ?? "all"}
                accessibilityRole="button"
                onPress={() => setEnvironmentId(environment.id)}
                accessibilityState={{ selected: environmentId === environment.id }}
                className="p-2"
              >
                <Text
                  className={
                    environmentId === environment.id
                      ? "text-sm text-primary"
                      : "text-sm text-foreground-muted"
                  }
                >
                  {environment.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        <SegmentedControl
          scrollable
          options={[
            "overview",
            "models",
            "projects",
            "threads",
            ...(selectedAccount ? ["environments"] : []),
            "limits",
          ].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))}
          selected={tab}
          onSelect={setTab}
        />
        <Animated.View
          key={tab}
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          className="gap-6"
        >
          {showingLimits ? (
            <UsageLimitsSection
              now={limits.now}
              failedLabels={limits.failedLabels}
              selectedEnvironmentIds={selectedEnvironmentIds}
              cursorPrompt={
                cursorAccessEnvironments.length > 0 ? (
                  <CursorEnableLimits
                    environments={cursorAccessEnvironments}
                    onEnabled={refreshAfterCursorEnable}
                  />
                ) : null
              }
            />
          ) : (
            <>
              <SegmentedControl
                options={WINDOW_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                selected={windowDays}
                onSelect={selectWindow}
              />

              <UsageCoverageNotice
                environments={environments}
                merged={merged}
                isPartial={isPartial}
              />

              {merged.duplicateSources.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Counted once across environments sharing a transcript directory:{" "}
                  {merged.duplicateSources.join(", ")}
                </Text>
              ) : null}

              {selectedAccount && tab === "overview" && (
                <SubscriptionLimitsSection
                  limits={subscriptionLimits}
                  isPending={isProviderAvailabilityPending}
                  hasError={hasProviderAvailabilityError}
                  nowMs={resetClockMs}
                />
              )}

              {isPending ||
              (Boolean(accountKey) && !selectedAccount && isProviderAvailabilityPending) ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  Scanning provider transcripts…
                </Text>
              ) : environments.length === 0 ? (
                <Text className="py-16 text-center text-base text-foreground-muted">
                  Connect an environment to see usage.
                </Text>
              ) : !hasMappedHistory && tab !== "environments" ? (
                <Text className="py-8 text-sm text-foreground-muted">
                  No history can currently be assigned to this account in the selected environments.
                  Shared or unmapped history is available in All accounts.
                </Text>
              ) : (
                <>
                  {sourceMessages.map((message) => (
                    <Text key={message} className="text-sm text-foreground-muted">
                      {message}
                    </Text>
                  ))}
                  {tab === "environments" && selectedAccount ? (
                    selectedAccount.memberships
                      .filter(
                        (member) =>
                          environmentId === null || member.environmentId === environmentId,
                      )
                      .map((member) => (
                        <View
                          key={usageAccountMemberKey(member)}
                          className="gap-1 border-b border-border pb-3"
                        >
                          <Text className="font-t3-medium text-foreground">
                            {member.environmentLabel}
                          </Text>
                          <Text className="text-sm text-foreground-muted">
                            {member.provider.version ?? "Version not reported"}
                            {member.provider.versionAdvisory?.status === "behind_latest"
                              ? " · Update available"
                              : ""}
                          </Text>
                          <Text className="text-xs text-foreground-muted">
                            {member.isConnected === false
                              ? "Offline"
                              : !member.provider.enabled
                                ? "Disabled"
                                : !member.provider.installed
                                  ? "Not installed"
                                  : member.provider.auth.status === "authenticated"
                                    ? "Signed in"
                                    : member.provider.auth.status === "unauthenticated"
                                      ? "Signed out"
                                      : "Unknown"}{" "}
                            · {formatDateTimeShort(member.provider.checkedAt, window.timeZone)}
                          </Text>
                        </View>
                      ))
                  ) : (
                    <>
                      <View className="gap-1">
                        <Text className="text-3xl font-t3-medium tabular-nums text-foreground">
                          {metric === "cost"
                            ? formatUsd(merged.costUsd)
                            : formatTokens(merged.totalTokens)}
                        </Text>
                        <Text className="text-sm text-foreground-muted">
                          {metric === "cost" ? "Estimated API cost" : "Processed tokens"} · selected
                          period
                        </Text>
                      </View>
                      <SegmentedControl
                        options={[
                          { value: "cost", label: "API cost" },
                          { value: "tokens", label: "Tokens" },
                        ]}
                        selected={metric}
                        onSelect={setMetric}
                      />
                      {tab === "overview" && (
                        <SegmentedControl
                          options={[
                            { value: "provider", label: "Provider" },
                            { value: "account", label: "Account" },
                            { value: "environment", label: "Environment" },
                          ]}
                          selected={grouping}
                          onSelect={setGrouping}
                        />
                      )}
                      {tab === "threads" && (
                        <>
                          <Text className="text-base font-t3-medium text-foreground">
                            Sessions created
                          </Text>
                          {!selectedAccount && (
                            <SegmentedControl
                              options={[
                                { value: "total", label: "Total" },
                                { value: "provider", label: "By provider" },
                              ]}
                              selected={threadByProvider ? "provider" : "total"}
                              onSelect={(value) => setThreadByProvider(value === "provider")}
                            />
                          )}
                        </>
                      )}
                      <LineAreaChart
                        periods={chartDays}
                        label={
                          tab === "threads"
                            ? "Sessions created"
                            : metric === "cost"
                              ? "API cost"
                              : "Tokens"
                        }
                        height={CHART_HEIGHT}
                        series={chartRows}
                      />
                      <View className="flex-row justify-between">
                        <Text className="text-xs text-foreground-muted">
                          {chartDays[0]?.slice(0, 16).replace("T", " ")}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {chartDays.at(-1)?.slice(0, 16).replace("T", " ")}
                        </Text>
                      </View>
                      {tab === "threads" && (
                        <Text className="text-xs text-foreground-muted">
                          Phoenix threads created, including those without token usage.
                          {merged.threadCreationReporting === 0
                            ? " Creation history is not available from these environments."
                            : ""}
                        </Text>
                      )}
                      <View className="flex-row flex-wrap gap-3">
                        {chartRows.map((row) => (
                          <Text key={row.id} className="text-xs text-foreground-muted">
                            {row.label}
                          </Text>
                        ))}
                      </View>
                      {tab === "overview" && (
                        <>
                          <ProviderSection
                            merged={merged}
                            metric={metric}
                            cursorAccessEnvironments={cursorAccessEnvironments}
                            showCursorEnvironment={selectedEnvironments.length > 1}
                            onCursorEnabled={refreshAfterCursorEnable}
                          />
                          <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
                        </>
                      )}
                      {tab === "models" && <ModelsSection merged={merged} />}
                      {(tab === "projects" || tab === "threads") && (
                        <UsageReport key={tab} mode={tab} merged={merged} />
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </Animated.View>
      </ScrollView>
    </SettingsScreen>
  );
}

function CursorEnableAction({
  environmentId,
  label,
  onEnabled,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly buttonText?: string;
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Enable Cursor usage from ${label}`}
      accessibilityHint={CURSOR_KEYCHAIN_COPY}
      disabled={pending}
      onPress={() => void enable()}
      className="rounded-full bg-primary px-4 py-2"
    >
      <Text className="text-sm font-medium text-primary-foreground">{buttonText}</Text>
    </Pressable>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  bordered,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly bordered: boolean;
  readonly onEnabled: () => void;
}) {
  const colors = useProviderColors();
  return (
    <View
      className={cn(
        "flex-row items-center justify-between gap-3 p-4",
        bordered && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <View className="size-2.5 rounded-full" style={{ backgroundColor: colors.cursor }} />
        <Text className="shrink text-lg text-foreground">
          Cursor{showEnvironment ? ` · ${label}` : ""}
        </Text>
      </View>
      <CursorEnableAction environmentId={environmentId} label={label} onEnabled={onEnabled} />
    </View>
  );
}

function useMinuteClock(active: boolean): number {
  const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    if (!active) return;
    const delay = 60_000 - (now() % 60_000) + 25;
    const timeout = setTimeout(() => setNowMs(now()), delay);
    return () => clearTimeout(timeout);
  }, [active, nowMs]);
  return nowMs;
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2 px-1">
        <ProviderIcon provider="cursor" size={18} />
        <Text className="text-base font-t3-medium text-foreground">Cursor</Text>
      </View>
      <View className="items-start gap-3 rounded-[24px] border-continuous bg-card p-4">
        <Text className="text-xs text-foreground-muted">{CURSOR_KEYCHAIN_COPY}</Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableAction
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function SubscriptionLimitsSection(props: {
  readonly limits: readonly SubscriptionLimit[];
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly nowMs: number;
}) {
  return (
    <SettingsSection title="Subscription limits">
      <View className="gap-1 px-4 pt-4">
        <Text className="text-sm text-foreground-muted">
          Provider-reported limits for connected providers. Phoenix combines readings only when a
          provider supplies a verified account identity.
        </Text>
      </View>
      {props.limits.length === 0 ? (
        <Text className="px-4 pb-4 pt-3 text-sm text-foreground-muted">
          {props.isPending
            ? "Checking connected providers for subscription limits…"
            : props.hasError
              ? "Subscription limits could not be checked for every connected environment. Refresh Usage to try again."
              : "No subscription limits are available. Some providers do not report limits to Phoenix, and others report them only after you sign in."}
        </Text>
      ) : (
        <View className="gap-3 p-4">
          {props.limits.map((limit) => (
            <View key={limit.key} className="gap-3 rounded-[16px] border-continuous bg-sheet p-3.5">
              <View className="flex-row items-start justify-between gap-3">
                <View className="mt-0.5">
                  <ProviderIcon provider={limit.driver} size={18} />
                </View>
                <View className="min-w-0 flex-1 gap-0.5">
                  <View className="flex-row flex-wrap items-center gap-1.5">
                    <Text
                      className="shrink text-base font-t3-medium text-foreground"
                      numberOfLines={1}
                    >
                      {limit.name}
                    </Text>
                    {limit.instanceLabels.map((label) => (
                      <Text
                        key={label}
                        className="rounded-full border-continuous border border-border px-1.5 py-0.5 text-[10px] font-t3-medium leading-none text-foreground-muted"
                        style={
                          limit.accentColor
                            ? { borderColor: limit.accentColor, color: limit.accentColor }
                            : undefined
                        }
                      >
                        {label}
                      </Text>
                    ))}
                  </View>
                  <Text className="text-xs leading-relaxed text-foreground-muted">
                    Reported by {limit.environmentLabels.join(", ")}
                    {!limit.isAccount
                      ? ". This provider does not share an account identity, so this reading stays separate."
                      : ""}
                  </Text>
                </View>
                {limit.availability.status === "limited" ? (
                  <Text className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-t3-medium text-warning">
                    Limit reached
                  </Text>
                ) : limit.isCurrentAvailabilityUnknown ? (
                  <Text className="rounded-full bg-subtle px-2 py-0.5 text-xs font-t3-medium text-foreground-muted">
                    Availability unknown
                  </Text>
                ) : null}
              </View>
              {limit.availability.windows.map((window) => {
                const label = subscriptionLimitWindowLabel(window);
                const reset = subscriptionLimitResetLabel(window, props.nowMs);
                const progressLabel = `${label}: ${window.usedPercent}% used${reset ? `. ${reset}.` : ""}`;
                return (
                  <View key={`${window.kind}:${window.scope ?? ""}`} className="gap-1.5">
                    <View className="flex-row items-baseline justify-between gap-3">
                      <Text
                        className="min-w-0 flex-1 text-xs font-t3-medium text-foreground"
                        numberOfLines={1}
                      >
                        {label}
                      </Text>
                      <Text className="text-xs tabular-nums text-foreground-muted">
                        {window.usedPercent}% used{reset ? ` · ${reset}` : ""}
                      </Text>
                    </View>
                    <View
                      accessibilityLabel={progressLabel}
                      accessibilityRole="progressbar"
                      accessibilityValue={{
                        min: 0,
                        max: 100,
                        now: window.usedPercent,
                        text: progressLabel,
                      }}
                      className="h-1.5 overflow-hidden rounded-full bg-subtle"
                    >
                      <View
                        className={
                          window.usedPercent >= 100
                            ? "h-full bg-destructive"
                            : window.usedPercent >= 80
                              ? "h-full bg-warning"
                              : "h-full bg-primary"
                        }
                        style={{ width: `${window.usedPercent}%` }}
                      />
                    </View>
                  </View>
                );
              })}
              {limit.isStale ? (
                <Text className="text-xs leading-relaxed text-foreground-muted">
                  This provider's previous quota reading has expired. Refresh Usage to check again.
                </Text>
              ) : limit.isCurrentAvailabilityUnknown ? (
                <Text className="text-xs leading-relaxed text-foreground-muted">
                  This provider could not confirm that these quota limits are current. Refresh Usage
                  to check again.
                </Text>
              ) : null}
              {limit.hasDivergentSnapshots ? (
                <Text className="text-xs leading-relaxed text-foreground-muted">
                  Connected environments reported different readings; this card shows the latest
                  one.
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  readonly cursorAccessEnvironments: readonly EnvironmentUsageStatus[];
  readonly showCursorEnvironment: boolean;
  readonly onCursorEnabled: () => void;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0 && props.cursorAccessEnvironments.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );
  const rows: Array<
    | { readonly kind: "usage"; readonly provider: (typeof ordered)[number] }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = ordered.map((provider) => ({ kind: "usage", provider }));
  const cursorInsertAt =
    Math.max(
      ordered.findIndex((provider) => provider.provider === "codex"),
      ordered.findIndex((provider) => provider.provider === "claude"),
    ) + 1;
  rows.splice(
    cursorInsertAt,
    0,
    ...props.cursorAccessEnvironments.map((environment) => ({
      kind: "enable" as const,
      environment,
    })),
  );

  return (
    <SettingsSection title="Providers">
      {rows.map((row, index) => {
        if (row.kind === "enable") {
          return (
            <CursorEnableRow
              key={`enable:${row.environment.environmentId}`}
              environmentId={row.environment.environmentId}
              label={row.environment.label}
              showEnvironment={props.showCursorEnvironment}
              bordered={index > 0}
              onEnabled={props.onCursorEnabled}
            />
          );
        }
        const provider = row.provider;
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text className="text-lg text-foreground">{PROVIDER_LABEL[provider.provider]}</Text>
              </View>
              <Text className="text-lg tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ flex: share, backgroundColor: colors[provider.provider] }}
              />
              <View style={{ flex: 1 - share }} />
            </View>
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: { readonly merged: MergedUsage; readonly isPast24Hours: boolean }) {
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title="Totals">
      <View className="flex-row flex-wrap">
        <MetricCell
          label="Processed tokens"
          value={formatTokens(merged.totalTokens)}
          detail={`${formatTokens(periodAverage)} per active ${props.isPast24Hours ? "hour" : "day"}`}
        />
        <MetricCell
          label="Cache savings"
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw cost`
              : "vs full input rates"
          }
        />
        <MetricCell
          label="Cached input"
          value={formatTokens(merged.cachedInputTokens)}
          detail={`${formatPercent(cachedShare)} of observed input`}
        />
        <MetricCell
          label="Uncached input"
          value={formatTokens(merged.uncachedInputTokens)}
          detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
        />
        <MetricCell
          label="Output"
          value={formatTokens(merged.outputTokens)}
          detail={`incl. ${formatTokens(merged.reasoningTokens)} reasoning`}
        />
        <MetricCell
          label="Unpriced"
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail="of records, excluded from cost"
        />
      </View>
    </SettingsSection>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <View className="w-1/2 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: { readonly merged: MergedUsage }) {
  const { merged } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  return (
    <SettingsSection title="By model">
      {merged.models.map((model, index) => (
        <View
          key={`${model.provider}:${model.model}`}
          className={
            index === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
        >
          <View
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors[model.provider] }}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {model.model}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {isModelCostUnknown(model)
                ? `no known rates · ${formatTokens(model.totalTokens)} tokens`
                : `${formatPercent(model.costShare)} of cost · ${formatTokens(model.totalTokens)} tokens`}
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">
            {isModelCostUnknown(model) ? "Unpriced" : formatUsd(model.costUsd)}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment still answering,
 * one that failed, or one whose transcripts another environment already
 * reported.
 */
function isUsageLoading(environment: EnvironmentUsageStatus) {
  return environment.isPending || (environment.summary === null && environment.error === null);
}

function usageEnvironmentStatus(environment: EnvironmentUsageStatus): string {
  if (
    environment.summary &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  ) {
    return "Older server · excluded from usage totals";
  }
  if (!environment.isConnected)
    return environment.summary ? "Disconnected · showing saved usage" : "Waiting for connection…";
  if (environment.error)
    return environment.summary ? "Usage unavailable · showing saved totals" : "Usage unavailable";
  if (isUsageLoading(environment))
    return environment.summary ? "Updating usage…" : "Loading usage…";
  return "Usage up to date";
}
