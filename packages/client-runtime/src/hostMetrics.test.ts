import type { HostMetricsHistorySample, HostMetricsSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatHostMetricBytes,
  hostMetricTrendBuckets,
  hostMetricWarnings,
  mergeHostMetricSamples,
  sustainedCpuWarning,
} from "./hostMetrics.ts";

const start = DateTime.makeUnsafe("2026-08-22T12:00:00.000Z");

function sample(second: number, cpu: number | null = 95): HostMetricsHistorySample {
  return {
    sampledAt: DateTime.addDuration(start, `${second} seconds`),
    cpuUtilizationPercent: cpu,
    memoryUtilizationPercent: 50,
  };
}

function snapshot(memoryAvailabilityKind: "available" | "free" = "available"): HostMetricsSnapshot {
  const sampledAt = DateTime.addDuration(start, "30 seconds");
  return {
    sampledAt,
    sampleIntervalMs: 1_000,
    cpu: {
      status: "available",
      statusReason: null,
      utilizationPercent: 95,
      loadAverage1m: 1,
      loadAverage5m: 1,
      loadAverage15m: 1,
    },
    memory: {
      status: "available",
      statusReason: null,
      availabilityKind: memoryAvailabilityKind,
      totalBytes: 100 * 1_024 ** 3,
      availableBytes: 5 * 1_024 ** 3,
      usedBytes: 95 * 1_024 ** 3,
      utilizationPercent: 95,
    },
    storage: [
      {
        kind: "shared",
        status: "available",
        totalBytes: 200 * 1_024 ** 3,
        availableBytes: 9 * 1_024 ** 3,
        usedBytes: 191 * 1_024 ** 3,
        utilizationPercent: 95.5,
      },
    ],
    phoenix: {
      cpuCorePercent: 20,
      cpuMachinePercent: 5,
      residentBytes: 1_024,
      memoryMachinePercent: 1,
      processCount: 2,
      ioReadBytesPerSecond: 0,
      ioWriteBytesPerSecond: 0,
      sourceStatus: "healthy",
    },
    inventory: {
      logicalCpuCount: 4,
      totalMemoryBytes: 100 * 1_024 ** 3,
      systemUptimeSeconds: 100,
      serverUptimeSeconds: 50,
    },
    administrativeDetails: null,
  };
}

describe("host metrics presentation", () => {
  it("labels binary capacity with binary units", () => {
    expect(formatHostMetricBytes(16 * 1_024 ** 3)).toBe("16 GiB");
  });

  it("warns only after CPU remains continuously above 90% for 30 seconds", () => {
    const samples = Array.from({ length: 31 }, (_, index) => sample(index));
    const nowMs = DateTime.toEpochMillis(samples.at(-1)!.sampledAt);
    expect(sustainedCpuWarning(samples, nowMs)).toEqual({
      resource: "cpu",
      message: "CPU stayed above 90% for 30 seconds.",
    });
    expect(sustainedCpuWarning(samples.slice(1), nowMs)).toBeNull();
    expect(sustainedCpuWarning(samples.with(15, sample(15, 90)), nowMs)).toBeNull();
    expect(
      sustainedCpuWarning(
        samples.filter((_, index) => index !== 14 && index !== 15),
        nowMs,
      ),
    ).toBeNull();
    expect(sustainedCpuWarning(samples.with(15, sample(15, null)), nowMs)).toBeNull();
  });

  it("warns for trustworthy available memory and low storage", () => {
    const warnings = hostMetricWarnings(snapshot(), []);
    expect(warnings.map((warning) => warning.resource)).toEqual(["memory", "storage"]);
  });

  it("does not warn from portable free-only memory readings", () => {
    const warnings = hostMetricWarnings(snapshot("free"), []);
    expect(warnings.some((warning) => warning.resource === "memory")).toBe(false);
  });

  it("time-prunes merged samples and preserves holes in fixed trend buckets", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.addDuration(start, "20 minutes"));
    const merged = mergeHostMetricSamples([sample(0), sample(6 * 60)], [sample(20 * 60)], nowMs);
    expect(merged.map((entry) => DateTime.toEpochMillis(entry.sampledAt))).toEqual([
      DateTime.toEpochMillis(sample(6 * 60).sampledAt),
      DateTime.toEpochMillis(sample(20 * 60).sampledAt),
    ]);

    const buckets = hostMetricTrendBuckets(merged, 3, nowMs);
    expect(buckets.map((entry) => entry.sample?.cpuUtilizationPercent ?? null)).toEqual([
      95,
      null,
      95,
    ]);
  });
});
