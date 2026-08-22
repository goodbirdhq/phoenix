import type {
  HostMetricsHistorySample,
  HostMetricsSnapshot,
  HostMetricsStorage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const GIBIBYTE = 1_024 ** 3;
const CPU_WARNING_WINDOW_MS = 30_000;
const CPU_WARNING_MAX_SAMPLE_GAP_MS = 2_500;

export type HostMetricWarningResource = "cpu" | "memory" | "storage";

export interface HostMetricWarning {
  readonly resource: HostMetricWarningResource;
  readonly message: string;
}

export interface HostMetricTrendBucket {
  readonly startedAtMs: number;
  readonly sample: HostMetricsHistorySample | null;
}

export function formatHostMetricBytes(bytes: number): string {
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  let value = bytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 10 ? 1 : 2 })} ${units[unitIndex]}`;
}

export function formatHostMetricPercent(value: number | null): string {
  return value === null ? "Waiting…" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatHostUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function storageLabel(storage: HostMetricsStorage): string {
  switch (storage.kind) {
    case "server":
      return "Server storage";
    case "phoenix":
      return "Phoenix storage";
    case "shared":
      return "Server & Phoenix storage";
  }
}

export function sustainedCpuWarning(
  samples: ReadonlyArray<HostMetricsHistorySample>,
  nowMs: number,
): HostMetricWarning | null {
  const windowStartMs = nowMs - CPU_WARNING_WINDOW_MS;
  const windowSamples = samples
    .filter((sample) => {
      const sampledAtMs = DateTime.toEpochMillis(sample.sampledAt);
      return sampledAtMs >= windowStartMs - CPU_WARNING_MAX_SAMPLE_GAP_MS && sampledAtMs <= nowMs;
    })
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.sampledAt) - DateTime.toEpochMillis(right.sampledAt),
    );
  const first = windowSamples[0];
  const last = windowSamples.at(-1);
  if (
    !first ||
    !last ||
    DateTime.toEpochMillis(first.sampledAt) > windowStartMs ||
    nowMs - DateTime.toEpochMillis(last.sampledAt) > CPU_WARNING_MAX_SAMPLE_GAP_MS ||
    windowSamples.some(
      (sample, index) =>
        sample.cpuUtilizationPercent === null ||
        sample.cpuUtilizationPercent <= 90 ||
        (index > 0 &&
          DateTime.toEpochMillis(sample.sampledAt) -
            DateTime.toEpochMillis(windowSamples[index - 1]!.sampledAt) >
            CPU_WARNING_MAX_SAMPLE_GAP_MS),
    )
  ) {
    return null;
  }
  return { resource: "cpu", message: "CPU stayed above 90% for 30 seconds." };
}

export function mergeHostMetricSamples(
  history: ReadonlyArray<HostMetricsHistorySample>,
  live: ReadonlyArray<HostMetricsHistorySample>,
  nowMs?: number,
): readonly HostMetricsHistorySample[] {
  const byTime = new Map<number, HostMetricsHistorySample>();
  for (const sample of [...history, ...live]) {
    byTime.set(DateTime.toEpochMillis(sample.sampledAt), sample);
  }
  const ordered = [...byTime.values()].toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.sampledAt) - DateTime.toEpochMillis(right.sampledAt),
  );
  const last = ordered.at(-1);
  const latestMs = nowMs ?? (last ? DateTime.toEpochMillis(last.sampledAt) : 0);
  const cutoff = latestMs - 15 * 60 * 1_000;
  return ordered.filter((sample) => DateTime.toEpochMillis(sample.sampledAt) >= cutoff);
}

export function hostMetricTrendBuckets(
  samples: ReadonlyArray<HostMetricsHistorySample>,
  bucketCount: number,
  nowMs?: number,
): ReadonlyArray<HostMetricTrendBucket> {
  if (bucketCount <= 0) return [];
  const ordered = mergeHostMetricSamples(samples, [], nowMs);
  const last = ordered.at(-1);
  const latestMs = nowMs ?? (last ? DateTime.toEpochMillis(last.sampledAt) : 0);
  const windowMs = 15 * 60 * 1_000;
  const windowStartMs = latestMs - windowMs;
  const bucketMs = windowMs / bucketCount;
  const samplesByBucket = Array.from<HostMetricsHistorySample | null>({ length: bucketCount }).fill(
    null,
  );
  for (const sample of ordered) {
    const sampledAtMs = DateTime.toEpochMillis(sample.sampledAt);
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((sampledAtMs - windowStartMs) / bucketMs)),
    );
    samplesByBucket[index] = sample;
  }
  return samplesByBucket.map((sample, index) => ({
    startedAtMs: windowStartMs + index * bucketMs,
    sample,
  }));
}

export function hostMetricWarnings(
  snapshot: HostMetricsSnapshot,
  history: ReadonlyArray<HostMetricsHistorySample>,
): readonly HostMetricWarning[] {
  const warnings: HostMetricWarning[] = [];
  const cpu = sustainedCpuWarning(history, DateTime.toEpochMillis(snapshot.sampledAt));
  if (cpu) warnings.push(cpu);

  if (
    snapshot.memory.status === "available" &&
    snapshot.memory.availabilityKind === "available" &&
    snapshot.memory.totalBytes > 0 &&
    snapshot.memory.availableBytes / snapshot.memory.totalBytes < 0.1
  ) {
    warnings.push({
      resource: "memory",
      message: `Only ${formatHostMetricBytes(snapshot.memory.availableBytes)} of memory is available.`,
    });
  }

  for (const storage of snapshot.storage) {
    if (
      storage.status === "available" &&
      storage.totalBytes > 0 &&
      (storage.availableBytes / storage.totalBytes < 0.1 || storage.availableBytes < 10 * GIBIBYTE)
    ) {
      warnings.push({
        resource: "storage",
        message: `${storageLabel(storage)} has ${formatHostMetricBytes(storage.availableBytes)} free.`,
      });
    }
  }
  return warnings;
}
