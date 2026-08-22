import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  formatHostMetricBytes,
  formatHostMetricPercent,
  formatHostUptime,
  hostMetricTrendBuckets,
  hostMetricWarnings,
  mergeHostMetricSamples,
  storageLabel,
} from "@t3tools/client-runtime/host-metrics";
import { EnvironmentId, type HostMetricsHistorySample } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentPresentation } from "../../state/presentation";
import {
  type MobileEnvironmentHostMetricsStatus,
  useMobileHostMetricsHistory,
  useMobileHostMetricsOverview,
  useMobileLiveHostMetrics,
} from "../../state/hostMetrics";

function statusLabel(environment: MobileEnvironmentHostMetricsStatus): string {
  if (environment.connectionPhase !== "connected") {
    if (
      environment.connectionPhase === "connecting" ||
      environment.connectionPhase === "reconnecting"
    ) {
      return "Connecting";
    }
    return environment.connectionPhase === "error" ? "Connection failed" : "Offline";
  }
  if (!environment.supportsHostMetrics) return "Update required";
  if (environment.failed) return "Metrics unavailable";
  if (!environment.snapshot) return "Loading metrics";
  return "Connected";
}

export function EnvironmentMetricsRouteScreen() {
  const navigation = useNavigation();
  const { environments, refresh } = useMobileHostMetricsOverview();
  const ordered = useMemo(
    () =>
      environments.toSorted((left, right) => {
        const leftConnected = left.connectionPhase === "connected";
        const rightConnected = right.connectionPhase === "connected";
        if (leftConnected !== rightConnected) return leftConnected ? -1 : 1;
        return left.label.localeCompare(right.label);
      }),
    [environments],
  );
  const refreshing = environments.some(
    (environment) => environment.pending && environment.snapshot !== null,
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Environments" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <FlatList
        data={ordered}
        keyExtractor={(environment) => environment.environmentId}
        contentContainerClassName="gap-3 px-5 py-4"
        contentContainerStyle={ordered.length === 0 ? { flexGrow: 1 } : undefined}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item }) => (
          <EnvironmentMetricsRow
            environment={item}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsEnvironmentPerformanceDetail",
                  params: { environmentId: item.environmentId },
                },
              })
            }
          />
        )}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center gap-3 px-8">
            <SymbolView name="server.rack" size={32} tintColor="#888888" />
            <Text className="text-center text-base text-foreground-muted">
              Connect an environment to inspect machine pressure.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function EnvironmentMetricsRow({
  environment,
  onPress,
}: {
  environment: MobileEnvironmentHostMetricsStatus;
  onPress: () => void;
}) {
  const icon = useThemeColor("--color-icon");
  const chevron = useThemeColor("--color-chevron");
  const snapshot = environment.snapshot;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${environment.label}, ${statusLabel(environment)}`}
      onPress={onPress}
      className="rounded-[22px] bg-card p-4 active:opacity-70"
    >
      <View className="flex-row items-start gap-3">
        <SymbolView name="server.rack" size={22} tintColor={icon} />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-semibold text-foreground" numberOfLines={1}>
            {environment.label}
          </Text>
          <Text className="text-sm text-foreground-muted">{statusLabel(environment)}</Text>
          {snapshot ? (
            <View className="mt-2 flex-row gap-5">
              <Metric
                label="CPU"
                value={
                  snapshot.cpu.status === "unavailable"
                    ? "Unavailable"
                    : formatHostMetricPercent(snapshot.cpu.utilizationPercent)
                }
              />
              <Metric
                label="RAM"
                value={
                  snapshot.memory.status === "available"
                    ? snapshot.memory.availabilityKind === "available"
                      ? formatHostMetricPercent(snapshot.memory.utilizationPercent)
                      : `${formatHostMetricBytes(snapshot.memory.availableBytes)} free`
                    : "Unavailable"
                }
              />
              <Metric label="Processes" value={`${snapshot.phoenix.processCount}`} />
            </View>
          ) : null}
        </View>
        <SymbolView name="chevron.right" size={16} tintColor={chevron} />
      </View>
    </Pressable>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-2xs font-t3-medium text-foreground-muted">{label}</Text>
      <Text className="font-mono text-sm text-foreground">{value}</Text>
    </View>
  );
}

type DetailProps = StaticScreenProps<{ readonly environmentId: string }>;

export function EnvironmentMetricsDetailRouteScreen(props: DetailProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const environment = presentation
    ? ({
        environmentId,
        label: presentation.entry.target.label,
        connectionPhase: presentation.connection.phase,
        supportsHostMetrics:
          presentation.serverConfig?.environment.capabilities.hostMetrics === true,
        platform: presentation.serverConfig?.environment.platform ?? null,
        serverVersion: presentation.serverConfig?.environment.serverVersion ?? null,
        snapshot: null,
        pending: false,
        failed: false,
      } satisfies MobileEnvironmentHostMetricsStatus)
    : null;
  const enabled = environment?.connectionPhase === "connected" && environment.supportsHostMetrics;
  const live = useMobileLiveHostMetrics(environmentId, enabled);
  const history = useMobileHostMetricsHistory(environmentId, enabled);
  const [liveSamples, setLiveSamples] = useState<readonly HostMetricsHistorySample[]>([]);

  useEffect(() => {
    if (!live.data) return;
    const next: HostMetricsHistorySample = {
      sampledAt: live.data.sampledAt,
      cpuUtilizationPercent: live.data.cpu.utilizationPercent,
      memoryUtilizationPercent:
        live.data.memory.status === "available" && live.data.memory.availabilityKind === "available"
          ? live.data.memory.utilizationPercent
          : null,
    };
    setLiveSamples((current) => mergeHostMetricSamples(current, [next]));
  }, [live.data]);

  useEffect(() => setLiveSamples([]), [environmentId]);

  const samples = useMemo(() => {
    return mergeHostMetricSamples(history.data?.samples ?? [], liveSamples);
  }, [history.data?.samples, liveSamples]);
  const snapshot = live.data ?? environment?.snapshot ?? null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={environment?.label ?? "Environment"}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: environment?.label ?? "Environment" }} />
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={live.isPending && snapshot !== null}
            onRefresh={() => {
              live.refresh();
              history.refresh();
            }}
          />
        }
      >
        {snapshot === null ? (
          <UnavailableEnvironment
            environment={environment}
            pending={live.isPending}
            requestError={live.error}
          />
        ) : (
          <MobileEnvironmentDetail
            environment={environment}
            snapshot={snapshot}
            samples={samples}
          />
        )}
      </ScrollView>
    </View>
  );
}

function UnavailableEnvironment({
  environment,
  pending,
  requestError,
}: {
  environment: MobileEnvironmentHostMetricsStatus | null;
  pending: boolean;
  requestError: string | null;
}) {
  return (
    <View className="items-center gap-3 px-6 py-16">
      {pending ? <ActivityIndicator /> : null}
      <SymbolView name="server.rack" size={32} tintColor="#888888" />
      <Text className="text-center text-base text-foreground-muted">
        {environment === null
          ? "This environment is no longer configured."
          : requestError
            ? "This environment could not report metrics. Try refreshing in a moment."
            : pending
              ? "Loading environment metrics…"
              : environment.supportsHostMetrics
                ? environment.connectionPhase === "connected"
                  ? "Metrics are currently unavailable for this environment."
                  : "Reconnect this environment to view live machine pressure."
                : "Update Phoenix on this environment to view performance metrics."}
      </Text>
    </View>
  );
}

function MobileEnvironmentDetail({
  environment,
  snapshot,
  samples,
}: {
  environment: MobileEnvironmentHostMetricsStatus | null;
  snapshot: NonNullable<MobileEnvironmentHostMetricsStatus["snapshot"]>;
  samples: readonly HostMetricsHistorySample[];
}) {
  const warnings = hostMetricWarnings(snapshot, samples);
  return (
    <>
      <View className="gap-1 px-1">
        <Text className="text-2xl font-t3-bold text-foreground">
          {environment?.label ?? "Environment"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {environment?.platform
            ? `${environment.platform.os} · ${environment.platform.arch} · `
            : ""}
          {snapshot.inventory.logicalCpuCount > 0
            ? `${snapshot.inventory.logicalCpuCount} logical cores`
            : "CPU inventory unavailable"}
          {snapshot.inventory.totalMemoryBytes > 0
            ? ` · ${formatHostMetricBytes(snapshot.inventory.totalMemoryBytes)} RAM`
            : ""}
        </Text>
      </View>

      {warnings.map((warning) => (
        <View
          key={`${warning.resource}:${warning.message}`}
          className="flex-row gap-2 rounded-[18px] bg-warning/15 p-4"
        >
          <SymbolView name="exclamationmark.triangle" size={18} tintColor="#b7791f" />
          <Text className="min-w-0 flex-1 text-sm text-foreground">{warning.message}</Text>
        </View>
      ))}

      <View className="gap-3">
        <ResourcePanel
          label="Host CPU"
          value={
            snapshot.cpu.status === "unavailable"
              ? "Unavailable"
              : formatHostMetricPercent(snapshot.cpu.utilizationPercent)
          }
          percent={snapshot.cpu.status === "available" ? snapshot.cpu.utilizationPercent : null}
          detail={
            snapshot.cpu.status === "unavailable"
              ? (snapshot.cpu.statusReason ?? "CPU metrics unavailable.")
              : `Phoenix ${snapshot.phoenix.cpuMachinePercent === null ? "unavailable" : formatHostMetricPercent(snapshot.phoenix.cpuMachinePercent)} · ${(snapshot.phoenix.cpuCorePercent / 100).toFixed(1)} cores`
          }
        />
        <ResourcePanel
          label="Host memory"
          value={
            snapshot.memory.status === "available"
              ? snapshot.memory.availabilityKind === "available"
                ? formatHostMetricPercent(snapshot.memory.utilizationPercent)
                : `${formatHostMetricBytes(snapshot.memory.availableBytes)} free`
              : "Unavailable"
          }
          percent={
            snapshot.memory.status === "available" &&
            snapshot.memory.availabilityKind === "available"
              ? snapshot.memory.utilizationPercent
              : null
          }
          detail={
            snapshot.memory.status === "available"
              ? snapshot.memory.availabilityKind === "available"
                ? `${formatHostMetricBytes(snapshot.memory.availableBytes)} available · Phoenix ${formatHostMetricBytes(snapshot.phoenix.residentBytes)}`
                : `Free memory; reclaimable caches are not counted · Phoenix ${formatHostMetricBytes(snapshot.phoenix.residentBytes)}`
              : (snapshot.memory.statusReason ?? "Memory metrics unavailable.")
          }
        />
      </View>

      <MobileTrend samples={samples} />

      <View className="gap-3">
        {snapshot.storage.map((storage) => (
          <View key={storage.kind} className="gap-2 rounded-[22px] bg-card p-4">
            <Text className="font-t3-semibold text-foreground">{storageLabel(storage)}</Text>
            {storage.status === "available" ? (
              <>
                <Text className="font-mono text-xl text-foreground">
                  {formatHostMetricPercent(storage.utilizationPercent)} used
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {formatHostMetricBytes(storage.availableBytes)} free of{" "}
                  {formatHostMetricBytes(storage.totalBytes)}
                </Text>
              </>
            ) : (
              <Text className="text-sm text-foreground-muted">{storage.reason}</Text>
            )}
          </View>
        ))}
      </View>

      <View className="gap-3 rounded-[22px] bg-card p-4">
        <Fact
          label="System uptime"
          value={formatHostUptime(snapshot.inventory.systemUptimeSeconds)}
        />
        <Fact
          label="Phoenix uptime"
          value={formatHostUptime(snapshot.inventory.serverUptimeSeconds)}
        />
        {environment?.serverVersion ? (
          <Fact label="Phoenix version" value={environment.serverVersion} />
        ) : null}
        {snapshot.cpu.loadAverage1m !== null ? (
          <Fact
            label="Load average"
            value={`${snapshot.cpu.loadAverage1m.toFixed(2)} · ${snapshot.cpu.loadAverage5m?.toFixed(2)} · ${snapshot.cpu.loadAverage15m?.toFixed(2)}`}
          />
        ) : null}
        <Fact label="Phoenix processes" value={`${snapshot.phoenix.processCount}`} />
        {snapshot.administrativeDetails ? (
          <>
            <Fact label="Processor" value={snapshot.administrativeDetails.cpuModel} />
            <Fact
              label="System version"
              value={`${snapshot.administrativeDetails.osVersion} · ${snapshot.administrativeDetails.kernelRelease}`}
            />
          </>
        ) : null}
      </View>
    </>
  );
}

function ResourcePanel({
  label,
  value,
  percent,
  detail,
}: {
  label: string;
  value: string;
  percent: number | null;
  detail: string;
}) {
  return (
    <View className="gap-3 rounded-[22px] bg-card p-4">
      <View className="flex-row items-end justify-between gap-3">
        <Text className="font-t3-semibold text-foreground">{label}</Text>
        <Text className="font-mono text-2xl text-foreground">{value}</Text>
      </View>
      {percent !== null ? (
        <View className="h-2 overflow-hidden rounded-full bg-subtle">
          <View
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </View>
      ) : null}
      <Text className="text-sm text-foreground-muted">{detail}</Text>
    </View>
  );
}

function MobileTrend({ samples }: { samples: readonly HostMetricsHistorySample[] }) {
  const buckets = hostMetricTrendBuckets(samples, 40);
  const populatedCount = buckets.filter((bucket) => bucket.sample !== null).length;
  return (
    <View className="gap-3 rounded-[22px] bg-card p-4">
      <View>
        <Text className="font-t3-semibold text-foreground">Recent pressure</Text>
        <Text className="text-sm text-foreground-muted">Up to 15 minutes, memory only</Text>
      </View>
      {populatedCount < 2 ? (
        <Text className="py-8 text-center text-sm text-foreground-muted">
          Collecting trend data…
        </Text>
      ) : (
        <View className="h-24 flex-row items-end gap-0.5">
          {buckets.map((bucket) => (
            <View key={bucket.startedAtMs} className="min-w-0 flex-1 flex-row items-end gap-px">
              <View
                className="min-w-px flex-1 rounded-t-sm bg-primary"
                style={{
                  height: `${bucket.sample?.cpuUtilizationPercent === null || bucket.sample === null ? 0 : Math.max(2, bucket.sample.cpuUtilizationPercent)}%`,
                }}
              />
              <View
                className="min-w-px flex-1 rounded-t-sm bg-accent"
                style={{
                  height: `${bucket.sample?.memoryUtilizationPercent === null || bucket.sample === null ? 0 : Math.max(2, bucket.sample.memoryUtilizationPercent)}%`,
                }}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-4 border-b border-border/60 pb-3 last:border-b-0 last:pb-0">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <Text className="min-w-0 flex-1 text-right text-sm text-foreground" numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
