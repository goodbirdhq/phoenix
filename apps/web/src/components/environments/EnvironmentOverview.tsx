import {
  formatHostMetricBytes,
  formatHostMetricPercent,
  formatHostUptime,
  hostMetricTrendBuckets,
  hostMetricWarnings,
  storageLabel,
} from "@t3tools/client-runtime/host-metrics";
import type { HostMetricsHistorySample, HostMetricsSnapshot } from "@t3tools/contracts";
import type { ReactNode } from "react";
import {
  ActivityIcon,
  CircleAlertIcon,
  ClockIcon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  ChartLineIcon,
  NetworkIcon,
  TimerIcon,
} from "lucide-react";
import type { EnvironmentHostMetricsStatus } from "../../state/hostMetrics";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export function EnvironmentOverview({
  environment,
  snapshot,
  samples,
  live,
  processDetails,
  refreshing,
  onRefresh,
}: {
  environment: EnvironmentHostMetricsStatus;
  snapshot: HostMetricsSnapshot;
  samples: readonly HostMetricsHistorySample[];
  live: boolean;
  processDetails?: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const processMetricsAvailable =
    snapshot.phoenix.sourceStatus === "healthy" || snapshot.phoenix.sourceStatus === "degraded";
  const warnings = hostMetricWarnings(snapshot, samples);
  const cpuWarning = warnings.some((warning) => warning.resource === "cpu");
  const memoryWarning = warnings.some((warning) => warning.resource === "memory");

  return (
    <div className="space-y-6">
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

      <section className="grid gap-5 border-b border-border pb-6 md:grid-cols-3 md:gap-0">
        <ResourceCard
          icon={<CpuIcon className="size-4" />}
          label="Host CPU"
          value={
            snapshot.cpu.status === "unavailable"
              ? "Unavailable"
              : formatHostMetricPercent(snapshot.cpu.utilizationPercent)
          }
          warning={cpuWarning}
          detail={
            snapshot.cpu.status === "unavailable"
              ? (snapshot.cpu.statusReason ?? "CPU metrics unavailable.")
              : `${snapshot.inventory.logicalCpuCount} logical cores · Phoenix ${!processMetricsAvailable || snapshot.phoenix.cpuMachinePercent === null ? "unavailable" : formatHostMetricPercent(snapshot.phoenix.cpuMachinePercent)}`
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
          warning={memoryWarning}
          detail={
            snapshot.memory.status === "available"
              ? snapshot.memory.availabilityKind === "available"
                ? `${formatHostMetricBytes(snapshot.memory.availableBytes)} available · ${formatHostMetricBytes(snapshot.inventory.totalMemoryBytes)} total`
                : `Free memory; reclaimable caches are not counted · Phoenix ${processMetricsAvailable ? formatHostMetricBytes(snapshot.phoenix.residentBytes) : "unavailable"}`
              : (snapshot.memory.statusReason ?? "Memory metrics unavailable.")
          }
        />
        <ResourceCard
          icon={<NetworkIcon className="size-4" />}
          label="Phoenix footprint"
          value={
            processMetricsAvailable
              ? `${snapshot.phoenix.processCount} ${snapshot.phoenix.processCount === 1 ? "process" : "processes"}`
              : "Unavailable"
          }
          detail={
            processMetricsAvailable
              ? `${formatHostMetricBytes(snapshot.phoenix.residentBytes)} resident · ${formatHostMetricBytes(snapshot.phoenix.ioReadBytesPerSecond + snapshot.phoenix.ioWriteBytesPerSecond)}/s I/O`
              : "The process collector is not reporting metrics."
          }
        />
      </section>

      <TrendChart samples={samples} live={live} refreshing={refreshing} onRefresh={onRefresh} />

      <section>
        <h2 className="environment-inter flex items-center gap-2 text-base leading-[22px] font-semibold">
          <HardDriveIcon className="size-4 text-muted-foreground" />
          Storage
        </h2>
        <p className="mt-1 mb-3 text-xs leading-[18px] text-muted-foreground">
          Capacity on the volumes used by this environment
        </p>
        <div className="grid gap-8 sm:grid-cols-2">
          {snapshot.storage.map((storage) => (
            <StorageCard key={storage.kind} storage={storage} />
          ))}
        </div>
      </section>

      <section className="space-y-6">
        <div className="grid grid-cols-2 gap-8 border-y border-border py-[18px] lg:grid-cols-4">
          <Fact
            icon={<ClockIcon />}
            label="System uptime"
            value={formatHostUptime(snapshot.inventory.systemUptimeSeconds)}
          />
          <Fact
            icon={<TimerIcon />}
            label="Phoenix uptime"
            value={formatHostUptime(snapshot.inventory.serverUptimeSeconds)}
          />
          <Fact
            icon={<CpuIcon />}
            label="Processor"
            value={snapshot.administrativeDetails?.cpuModel ?? "Unavailable"}
          />
          <Fact
            icon={<ActivityIcon />}
            label="Load · 1 / 5 / 15 min"
            value={[
              snapshot.cpu.loadAverage1m,
              snapshot.cpu.loadAverage5m,
              snapshot.cpu.loadAverage15m,
            ]
              .map((v) => v?.toFixed(2) ?? "—")
              .join(" / ")}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base leading-[22px] font-semibold">Host and Phoenix</h2>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Host metrics cover this machine. Phoenix metrics cover its process tree.
            </p>
          </div>
          {processDetails}
        </div>
        <div className="grid gap-8 border-t border-border pt-4 sm:grid-cols-3">
          <Fact label="Phoenix version" value={environment.serverVersion ?? "Unknown"} />
          <Fact
            label="System version"
            value={
              snapshot.administrativeDetails
                ? `${snapshot.administrativeDetails.osVersion} · ${snapshot.administrativeDetails.kernelRelease}`
                : "Unavailable"
            }
          />
          <Fact
            label="Collector"
            value={
              snapshot.phoenix.sourceStatus.charAt(0).toUpperCase() +
              snapshot.phoenix.sourceStatus.slice(1)
            }
          />
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
  warning = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="environment-inter flex items-center gap-2 text-xs leading-[18px] text-muted-foreground">
        {icon} {label}
      </div>
      <div
        className={cn(
          "text-[30px] leading-9 font-semibold tabular-nums",
          warning && "text-amber-600 dark:text-amber-300",
        )}
      >
        {value}
      </div>
      <p className="text-xs leading-[18px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function StorageCard({ storage }: { storage: HostMetricsSnapshot["storage"][number] }) {
  if (storage.status === "unavailable") {
    return (
      <div className="min-w-0">
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
    <div className="min-w-0">
      <div className="text-sm leading-5 font-medium">{storageLabel(storage)}</div>
      <div className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", low ? "bg-amber-500" : "bg-foreground")}
          style={{ width: `${storage.utilizationPercent}%` }}
        />
      </div>
      <p className="mt-2.5 text-xs leading-[18px] text-muted-foreground">
        {formatHostMetricBytes(storage.availableBytes)} free of{" "}
        {formatHostMetricBytes(storage.totalBytes)}
      </p>
    </div>
  );
}

function TrendChart({
  samples,
  live,
  refreshing,
  onRefresh,
}: {
  samples: readonly HostMetricsHistorySample[];
  live: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
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
        return `${command}${x},${120 - Math.min(100, Math.max(0, value))}`;
      })
      .join(" ");
  };
  return (
    <section className="space-y-[14px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="environment-inter flex items-center gap-2 text-base leading-[22px] font-semibold">
            <ChartLineIcon className="size-4 text-muted-foreground" />
            Recent pressure
          </h2>
          <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
            Up to 15 minutes · History resets when the server restarts
          </p>
        </div>
        <div className="flex items-center gap-5">
          <span className="text-xs text-emerald-700">● {live ? "Live" : "Latest"}</span>
          <Button
            data-environment-control
            size="sm"
            variant="outline"
            className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px] shadow-none"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      {populatedCount < 2 ? (
        <div className="flex h-[140px] items-center justify-center text-xs text-muted-foreground">
          Collecting trend data…
        </div>
      ) : (
        <svg
          viewBox="0 0 100 140"
          preserveAspectRatio="none"
          className="h-[140px] w-full overflow-visible"
          role="img"
          aria-label="CPU and memory utilization over the last 15 minutes"
        >
          {[20, 70, 120].map((y) => (
            <line
              key={y}
              x1="0"
              y1={y}
              x2="100"
              y2={y}
              className="stroke-border"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={path((sample) => sample.cpuUtilizationPercent)}
            fill="none"
            className="stroke-foreground"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path((sample) => sample.memoryUtilizationPercent)}
            fill="none"
            className="stroke-sky-600"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <div className="flex justify-between text-xs leading-[18px] text-muted-foreground">
        <span>15 minutes ago</span>
        <span className="flex gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-foreground" />
            CPU
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-sky-600" />
            Memory
          </span>
          <span>Now</span>
        </span>
      </div>
    </section>
  );
}

function Fact({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex items-center gap-2 text-xs leading-[18px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
          icon && "environment-inter",
        )}
      >
        {icon}
        {label}
      </div>
      <div className={cn("mt-1.5", icon ? "text-sm leading-5" : "text-[13px] leading-[19px]")}>
        {value}
      </div>
    </div>
  );
}
