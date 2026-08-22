import {
  formatHostMetricBytes,
  formatHostMetricPercent,
  formatHostUptime,
  hostMetricTrendBuckets,
  hostMetricWarnings,
  mergeHostMetricSamples,
  storageLabel,
} from "@t3tools/client-runtime/host-metrics";
import type {
  EnvironmentId,
  HostMetricsHistorySample,
  HostMetricsSnapshot,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  CircleAlertIcon,
  ClockIcon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import {
  type EnvironmentHostMetricsStatus,
  useHostMetricsHistory,
  useHostMetricsOverview,
  useLiveHostMetrics,
} from "../../state/hostMetrics";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";

function environmentStateLabel(status: EnvironmentHostMetricsStatus): string {
  if (status.connectionPhase !== "connected") {
    if (status.connectionPhase === "connecting" || status.connectionPhase === "reconnecting") {
      return "Connecting";
    }
    return status.connectionPhase === "error" ? "Connection failed" : "Offline";
  }
  if (!status.supportsHostMetrics) return "Update required";
  if (status.error) return status.error;
  if (!status.snapshot) return "Loading metrics";
  return "Connected";
}

function orderEnvironments(
  environments: readonly EnvironmentHostMetricsStatus[],
  currentEnvironmentId: EnvironmentId | null,
): readonly EnvironmentHostMetricsStatus[] {
  return environments.toSorted((left, right) => {
    if (left.environmentId === currentEnvironmentId) return -1;
    if (right.environmentId === currentEnvironmentId) return 1;
    const leftConnected = left.connectionPhase === "connected";
    const rightConnected = right.connectionPhase === "connected";
    if (leftConnected !== rightConnected) return leftConnected ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

export function EnvironmentsPage() {
  const environments = useHostMetricsOverview();
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const ordered = useMemo(
    () => orderEnvironments(environments, currentEnvironmentId),
    [currentEnvironmentId, environments],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => currentEnvironmentId,
  );

  useEffect(() => {
    const selectionExists = ordered.some(
      (environment) => environment.environmentId === selectedEnvironmentId,
    );
    if (selectionExists) return;
    const next =
      ordered.find((environment) => environment.environmentId === currentEnvironmentId) ??
      ordered[0] ??
      null;
    setSelectedEnvironmentId(next?.environmentId ?? null);
  }, [currentEnvironmentId, ordered, selectedEnvironmentId]);

  const selected =
    ordered.find((environment) => environment.environmentId === selectedEnvironmentId) ?? null;
  const canReadSelected = selected?.connectionPhase === "connected" && selected.supportsHostMetrics;
  const live = useLiveHostMetrics(selectedEnvironmentId, canReadSelected);
  const history = useHostMetricsHistory(selectedEnvironmentId, canReadSelected);
  const [liveSamples, setLiveSamples] = useState<readonly HostMetricsHistorySample[]>([]);

  useEffect(() => setLiveSamples([]), [selectedEnvironmentId]);
  useEffect(() => {
    if (!live.data) return;
    const sample: HostMetricsHistorySample = {
      sampledAt: live.data.sampledAt,
      cpuUtilizationPercent: live.data.cpu.utilizationPercent,
      memoryUtilizationPercent:
        live.data.memory.status === "available" && live.data.memory.availabilityKind === "available"
          ? live.data.memory.utilizationPercent
          : null,
    };
    setLiveSamples((current) => mergeHostMetricSamples(current, [sample]));
  }, [live.data]);

  const samples = useMemo(
    () => mergeHostMetricSamples(history.data?.samples ?? [], liveSamples),
    [history.data?.samples, liveSamples],
  );
  const snapshot = live.data ?? selected?.snapshot ?? null;
  const selectEnvironment = (environmentId: EnvironmentId) => {
    setSelectedEnvironmentId(environmentId);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader />
        <div className="grid min-h-0 flex-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-border/60 bg-muted/10 lg:border-r lg:border-b-0">
            <ScrollArea className="max-h-52 lg:h-full lg:max-h-none">
              <div className="space-y-1 p-3">
                {ordered.length === 0 ? (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No environments configured.
                  </p>
                ) : null}
                {ordered.map((environment) => (
                  <EnvironmentRow
                    key={environment.environmentId}
                    environment={environment}
                    selected={environment.environmentId === selectedEnvironmentId}
                    current={environment.environmentId === currentEnvironmentId}
                    onSelect={() => selectEnvironment(environment.environmentId)}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
          <ScrollArea className="min-h-0">
            <main className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-7">
              {selected === null ? (
                <EmptyDetail />
              ) : snapshot === null ? (
                <UnavailableDetail environment={selected} />
              ) : (
                <EnvironmentDetail
                  environment={selected}
                  snapshot={snapshot}
                  samples={samples}
                  live={live.data !== null}
                  canViewProcessDetails={selected.environmentId === primaryEnvironmentId}
                  refreshing={live.isPending || history.isPending}
                  onRefresh={() => {
                    live.refresh();
                    history.refresh();
                  }}
                />
              )}
            </main>
          </ScrollArea>
        </div>
      </div>
    </SidebarInset>
  );
}

function PageHeader() {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border/60 px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
        isElectron &&
          "drag-region h-[52px] min-h-[52px] wco:h-[env(titlebar-area-height)] wco:min-h-[env(titlebar-area-height)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <WorkspaceBreadcrumb ariaLabel="Environments breadcrumb">
        <WorkspaceBreadcrumbItem current>Environments</WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </header>
  );
}

function EnvironmentRow({
  environment,
  selected,
  current,
  onSelect,
}: {
  environment: EnvironmentHostMetricsStatus;
  selected: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  const snapshot = environment.snapshot;
  const primaryStorage = snapshot?.storage.find((item) => item.status === "available");
  const state = environmentStateLabel(environment);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full cursor-pointer rounded-lg border px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-border bg-background shadow-xs"
          : "border-transparent hover:border-border/60 hover:bg-background/65",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{environment.label}</span>
            {current ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                Current
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                environment.connectionPhase === "connected"
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/45",
              )}
            />
            {state}
          </div>
          {snapshot ? (
            <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
              <span>
                CPU{" "}
                {snapshot.cpu.status === "unavailable"
                  ? "Unavailable"
                  : formatHostMetricPercent(snapshot.cpu.utilizationPercent)}
              </span>
              <span>
                RAM{" "}
                {snapshot.memory.status === "available"
                  ? snapshot.memory.availabilityKind === "available"
                    ? formatHostMetricPercent(snapshot.memory.utilizationPercent)
                    : `${formatHostMetricBytes(snapshot.memory.availableBytes)} free`
                  : "Unavailable"}
              </span>
              <span>
                Disk {formatHostMetricPercent(primaryStorage?.utilizationPercent ?? null)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function EmptyDetail() {
  return (
    <div className="py-24 text-center">
      <ServerIcon className="mx-auto size-8 text-muted-foreground/45" />
      <p className="mt-3 text-sm text-muted-foreground">Select an environment to inspect it.</p>
    </div>
  );
}

function UnavailableDetail({ environment }: { environment: EnvironmentHostMetricsStatus }) {
  return (
    <div className="py-24 text-center">
      <ServerIcon className="mx-auto size-8 text-muted-foreground/45" />
      <h1 className="mt-4 text-lg font-semibold">{environment.label}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {environmentStateLabel(environment) === "Update required"
          ? "Update Phoenix on this environment to view host performance metrics."
          : environment.connectionPhase === "connected"
            ? "This environment could not report metrics."
            : "Reconnect this environment to view live machine pressure."}
      </p>
    </div>
  );
}

function EnvironmentDetail({
  environment,
  snapshot,
  samples,
  live,
  canViewProcessDetails,
  refreshing,
  onRefresh,
}: {
  environment: EnvironmentHostMetricsStatus;
  snapshot: HostMetricsSnapshot;
  samples: readonly HostMetricsHistorySample[];
  live: boolean;
  canViewProcessDetails: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const warnings = hostMetricWarnings(snapshot, samples);
  const cpuWarning = warnings.some((warning) => warning.resource === "cpu");
  const memoryWarning = warnings.some((warning) => warning.resource === "memory");
  const platform = environment.platform;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{environment.label}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {live ? "Live" : "Latest"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {platform ? `${platform.os} · ${platform.arch} · ` : ""}
            {snapshot.inventory.logicalCpuCount > 0
              ? `${snapshot.inventory.logicalCpuCount} logical cores`
              : "CPU inventory unavailable"}
            {snapshot.inventory.totalMemoryBytes > 0
              ? ` · ${formatHostMetricBytes(snapshot.inventory.totalMemoryBytes)} RAM`
              : ""}
          </p>
        </div>
        <Button
          size="icon"
          variant="outline"
          onClick={onRefresh}
          aria-label="Refresh environment metrics"
        >
          <RefreshCwIcon className={cn("size-4", refreshing && "opacity-50")} />
        </Button>
      </div>

      {warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-4 py-3">
          {warnings.map((warning) => (
            <div
              key={`${warning.resource}:${warning.message}`}
              className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>{warning.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      <section className="grid overflow-hidden rounded-xl border border-border/70 bg-card md:grid-cols-3">
        <ResourceCard
          icon={<CpuIcon className="size-4" />}
          label="Host CPU"
          value={
            snapshot.cpu.status === "unavailable"
              ? "Unavailable"
              : formatHostMetricPercent(snapshot.cpu.utilizationPercent)
          }
          progress={snapshot.cpu.status === "available" ? snapshot.cpu.utilizationPercent : null}
          warning={cpuWarning}
          detail={
            snapshot.cpu.status === "unavailable"
              ? (snapshot.cpu.statusReason ?? "CPU metrics unavailable.")
              : `Phoenix ${snapshot.phoenix.cpuMachinePercent === null ? "unavailable" : formatHostMetricPercent(snapshot.phoenix.cpuMachinePercent)} · ${(snapshot.phoenix.cpuCorePercent / 100).toFixed(1)} cores`
          }
        />
        <ResourceCard
          icon={<MemoryStickIcon className="size-4" />}
          label="Host memory"
          value={
            snapshot.memory.status === "available"
              ? snapshot.memory.availabilityKind === "available"
                ? formatHostMetricPercent(snapshot.memory.utilizationPercent)
                : `${formatHostMetricBytes(snapshot.memory.availableBytes)} free`
              : "Unavailable"
          }
          progress={
            snapshot.memory.status === "available" &&
            snapshot.memory.availabilityKind === "available"
              ? snapshot.memory.utilizationPercent
              : null
          }
          warning={memoryWarning}
          detail={
            snapshot.memory.status === "available"
              ? snapshot.memory.availabilityKind === "available"
                ? `${formatHostMetricBytes(snapshot.memory.availableBytes)} available · Phoenix ${formatHostMetricBytes(snapshot.phoenix.residentBytes)}`
                : `Free memory; reclaimable caches are not counted · Phoenix ${formatHostMetricBytes(snapshot.phoenix.residentBytes)}`
              : (snapshot.memory.statusReason ?? "Memory metrics unavailable.")
          }
        />
        <ResourceCard
          icon={<ActivityIcon className="size-4" />}
          label="Phoenix footprint"
          value={`${snapshot.phoenix.processCount}`}
          detail={`${snapshot.phoenix.processCount === 1 ? "process" : "processes"} · ${formatHostMetricBytes(snapshot.phoenix.ioReadBytesPerSecond + snapshot.phoenix.ioWriteBytesPerSecond)}/s I/O`}
        />
      </section>

      <TrendChart samples={samples} />

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          Storage
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {snapshot.storage.map((storage) => (
            <StorageCard key={storage.kind} storage={storage} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border/70 bg-card">
        <div className="grid sm:grid-cols-2">
          <Fact
            icon={<ClockIcon />}
            label="System uptime"
            value={formatHostUptime(snapshot.inventory.systemUptimeSeconds)}
          />
          <Fact
            icon={<ServerIcon />}
            label="Phoenix uptime"
            value={formatHostUptime(snapshot.inventory.serverUptimeSeconds)}
          />
          {environment.serverVersion ? (
            <Fact icon={<ServerIcon />} label="Phoenix version" value={environment.serverVersion} />
          ) : null}
          {snapshot.cpu.loadAverage1m !== null ? (
            <Fact
              icon={<ActivityIcon />}
              label="Load average"
              value={`${snapshot.cpu.loadAverage1m.toFixed(2)} · ${snapshot.cpu.loadAverage5m?.toFixed(2)} · ${snapshot.cpu.loadAverage15m?.toFixed(2)}`}
            />
          ) : null}
          {snapshot.administrativeDetails ? (
            <>
              <Fact
                icon={<CpuIcon />}
                label="Processor"
                value={snapshot.administrativeDetails.cpuModel}
              />
              <Fact
                icon={<ActivityIcon />}
                label="System version"
                value={`${snapshot.administrativeDetails.osVersion} · ${snapshot.administrativeDetails.kernelRelease}`}
              />
            </>
          ) : null}
        </div>
        <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Phoenix metrics describe this environment’s process tree. Host metrics describe the
          machine as this environment sees it.
          {snapshot.phoenix.sourceStatus !== "healthy"
            ? ` Process collector: ${snapshot.phoenix.sourceStatus}.`
            : ""}
          {canViewProcessDetails ? (
            <Link
              to="/settings/diagnostics"
              className="ml-2 font-medium text-foreground hover:underline"
            >
              View process details
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ResourceCard({
  icon,
  label,
  value,
  detail,
  progress,
  warning = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  progress?: number | null;
  warning?: boolean;
}) {
  return (
    <div className="border-t border-border/60 p-5 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {icon} {label}
      </div>
      <div
        className={cn(
          "mt-3 font-mono text-3xl font-semibold tabular-nums",
          warning && "text-amber-600 dark:text-amber-300",
        )}
      >
        {value}
      </div>
      {progress !== undefined && progress !== null ? (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn("h-full rounded-full", warning ? "bg-amber-500" : "bg-foreground/70")}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      ) : null}
      <p className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function StorageCard({ storage }: { storage: HostMetricsSnapshot["storage"][number] }) {
  if (storage.status === "unavailable") {
    return (
      <div className="rounded-lg border border-border/70 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HardDriveIcon className="size-4 text-muted-foreground" />
          {storageLabel(storage)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{storage.reason}</p>
      </div>
    );
  }
  const low =
    storage.availableBytes / storage.totalBytes < 0.1 || storage.availableBytes < 10 * 1_024 ** 3;
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <HardDriveIcon className="size-4 text-muted-foreground" />
          {storageLabel(storage)}
        </span>
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            low && "text-amber-600 dark:text-amber-300",
          )}
        >
          {formatHostMetricPercent(storage.utilizationPercent)}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", low ? "bg-amber-500" : "bg-foreground/70")}
          style={{ width: `${storage.utilizationPercent}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {formatHostMetricBytes(storage.availableBytes)} free of{" "}
        {formatHostMetricBytes(storage.totalBytes)}
      </p>
    </div>
  );
}

function TrendChart({ samples }: { samples: readonly HostMetricsHistorySample[] }) {
  const buckets = hostMetricTrendBuckets(samples, 120);
  const populatedCount = buckets.filter((bucket) => bucket.sample !== null).length;
  const path = (valueOf: (sample: HostMetricsHistorySample) => number | null) => {
    let drawing = false;
    return buckets
      .map((bucket, index) => {
        const value = bucket.sample === null ? null : valueOf(bucket.sample);
        if (value === null) {
          drawing = false;
          return "";
        }
        const command = drawing ? "L" : "M";
        drawing = true;
        const x = buckets.length <= 1 ? 0 : (index / (buckets.length - 1)) * 100;
        return `${command}${x},${100 - Math.min(100, Math.max(0, value))}`;
      })
      .join(" ");
  };
  return (
    <section className="rounded-xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Recent pressure</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Up to 15 minutes, held in memory only
          </p>
        </div>
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-foreground" />
            CPU
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-sky-500" />
            RAM
          </span>
        </div>
      </div>
      {populatedCount < 2 ? (
        <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
          Collecting trend data…
        </div>
      ) : (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="mt-4 h-28 w-full overflow-visible"
          role="img"
          aria-label="CPU and memory utilization over the last 15 minutes"
        >
          <line
            x1="0"
            y1="50"
            x2="100"
            y2="50"
            className="stroke-border"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path((sample) => sample.cpuUtilizationPercent)}
            fill="none"
            className="stroke-foreground"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path((sample) => sample.memoryUtilizationPercent)}
            fill="none"
            className="stroke-sky-500"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </section>
  );
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 border-t border-border/60 px-4 py-4 first:border-t-0 sm:border-l sm:px-5 sm:[&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(odd)]:border-l-0 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
      <span>{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 truncate text-sm">{value}</div>
      </div>
    </div>
  );
}
