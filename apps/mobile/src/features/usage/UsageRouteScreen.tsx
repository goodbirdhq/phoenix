import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { SegmentedControl } from "../../components/SegmentedControl";
import { UsageReport } from "./UsageReport";
import {
  usageChartSeries,
  type UsageChartGrouping,
} from "@t3tools/client-runtime/usage/chart-series";
import { usageReportSeries } from "@t3tools/client-runtime/usage/report-chart-series";
import { findUsageAccount, usageAccountMemberKey } from "@t3tools/client-runtime/usage/accounts";
import { useNavigation } from "@react-navigation/native";
import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionLimitResetLabel,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
  type SubscriptionLimit,
} from "@t3tools/client-runtime/usage/subscription-availability";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";
import {
  enumerateDays,
  enumerateHourStarts,
  formatPercent,
  formatTokens,
  formatUsd,
  formatDateTimeShort,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SettingsSection } from "../settings/components/SettingsSection";
import { LineAreaChart } from "../../components/charts/LineAreaChart";
import type { UsageChartMetric } from "@t3tools/client-runtime/usage/chart-series";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const CHART_HEIGHT = 180;

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [accountKey, setAccountKey] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
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
  const {
    merged,
    accounts,
    allEnvironments,
    environments,
    isPending,
    isPartial,
    refresh,
    providerAvailability,
    isProviderAvailabilityPending,
    hasProviderAvailabilityError,
  } = useUsage(
    { ...window, includeSessions: tab === "projects" || tab === "threads" },
    environmentId,
    accountKey,
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

  // The pull spinner tracks re-scans of environments that have answered
  // before. The initial scan renders its own placeholder, and an unreachable
  // environment stays pending forever — neither may pin the spinner on.
  const refreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    refresh({ ...nextWindow, includeSessions: tab === "projects" || tab === "threads" });
    setWindowSelection({ days: windowDays, window: nextWindow });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Usage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshWindow} />}
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
          ].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))}
          selected={tab}
          onSelect={setTab}
        />
        <SegmentedControl
          options={WINDOW_OPTIONS.map((option) => ({ value: option.days, label: option.label }))}
          selected={windowDays}
          onSelect={selectWindow}
        />

        <UsageCoverageNotice environments={environments} merged={merged} isPartial={isPartial} />

        {selectedAccount && tab === "overview" && (
          <SubscriptionLimitsSection
            limits={subscriptionLimits}
            isPending={isProviderAvailabilityPending}
            hasError={hasProviderAvailabilityError}
            nowMs={resetClockMs}
          />
        )}

        {isPending || (Boolean(accountKey) && !selectedAccount && isProviderAvailabilityPending) ? (
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
            {tab === "environments" && selectedAccount ? (
              selectedAccount.memberships
                .filter(
                  (member) => environmentId === null || member.environmentId === environmentId,
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
                    <ProviderSection merged={merged} metric={metric} />
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
      </ScrollView>
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

function SubscriptionLimitsSection(props: {
  readonly limits: readonly SubscriptionLimit[];
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly nowMs: number;
}) {
  return (
    <SettingsSection title="Subscription limits" card>
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
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title="Providers" card>
      {ordered.map((provider, index) => {
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
    <SettingsSection title="Totals" card>
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
    <SettingsSection title="By model" card>
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
              {formatPercent(model.costShare)} of cost · {formatTokens(model.totalTokens)} tokens
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">{formatUsd(model.costUsd)}</Text>
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
function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const failed = props.environments.filter((environment) => environment.error !== null);
  const stale = props.environments.filter((environment) =>
    props.merged.staleEnvironments.includes(environment.environmentId),
  );
  const duplicateSources = props.merged.duplicateSources;
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    !props.isPartial
  ) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting. Totals are partial.
        </Text>
      ) : null}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report usage.
        </Text>
      ))}
      {stale.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} runs an older server version and is excluded from totals.
        </Text>
      ))}
      {duplicateSources.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
