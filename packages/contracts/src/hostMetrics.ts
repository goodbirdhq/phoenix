import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ResourceTelemetrySourceStatus } from "./resourceTelemetry.ts";

export const HOST_METRICS_HISTORY_WINDOW_MS = 15 * 60 * 1_000;
export const HOST_METRICS_MIN_SAMPLE_INTERVAL_MS = 1_000;
export const HOST_METRICS_MAX_SAMPLE_INTERVAL_MS = 60_000;

export const HostMetricsCpuStatus = Schema.Literals(["warming", "available", "unavailable"]);
export type HostMetricsCpuStatus = typeof HostMetricsCpuStatus.Type;

export const HostMetricsCpu = Schema.Struct({
  status: HostMetricsCpuStatus,
  statusReason: Schema.NullOr(TrimmedNonEmptyString),
  utilizationPercent: Schema.NullOr(Schema.Number),
  loadAverage1m: Schema.NullOr(Schema.Number),
  loadAverage5m: Schema.NullOr(Schema.Number),
  loadAverage15m: Schema.NullOr(Schema.Number),
});
export type HostMetricsCpu = typeof HostMetricsCpu.Type;

export const HostMetricsMemoryStatus = Schema.Literals(["available", "unavailable"]);
export type HostMetricsMemoryStatus = typeof HostMetricsMemoryStatus.Type;

export const HostMetricsMemoryAvailabilityKind = Schema.Literals(["available", "free"]);
export type HostMetricsMemoryAvailabilityKind = typeof HostMetricsMemoryAvailabilityKind.Type;

export const HostMetricsMemory = Schema.Struct({
  status: HostMetricsMemoryStatus,
  statusReason: Schema.NullOr(TrimmedNonEmptyString),
  availabilityKind: HostMetricsMemoryAvailabilityKind,
  totalBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  utilizationPercent: Schema.Number,
});
export type HostMetricsMemory = typeof HostMetricsMemory.Type;

export const HostMetricsStorageKind = Schema.Literals(["server", "phoenix", "shared"]);
export type HostMetricsStorageKind = typeof HostMetricsStorageKind.Type;

export const HostMetricsStorageAvailable = Schema.Struct({
  kind: HostMetricsStorageKind,
  status: Schema.Literal("available"),
  totalBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  utilizationPercent: Schema.Number,
});

export const HostMetricsStorageUnavailable = Schema.Struct({
  kind: HostMetricsStorageKind,
  status: Schema.Literal("unavailable"),
  reason: TrimmedNonEmptyString,
});

export const HostMetricsStorage = Schema.Union([
  HostMetricsStorageAvailable,
  HostMetricsStorageUnavailable,
]);
export type HostMetricsStorage = typeof HostMetricsStorage.Type;

export const HostMetricsPhoenixFootprint = Schema.Struct({
  cpuCorePercent: Schema.Number,
  cpuMachinePercent: Schema.NullOr(Schema.Number),
  residentBytes: NonNegativeInt,
  memoryMachinePercent: Schema.NullOr(Schema.Number),
  processCount: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  sourceStatus: ResourceTelemetrySourceStatus,
});
export type HostMetricsPhoenixFootprint = typeof HostMetricsPhoenixFootprint.Type;

export const HostMetricsInventory = Schema.Struct({
  logicalCpuCount: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
  systemUptimeSeconds: NonNegativeInt,
  serverUptimeSeconds: NonNegativeInt,
});
export type HostMetricsInventory = typeof HostMetricsInventory.Type;

export const HostMetricsAdministrativeDetails = Schema.Struct({
  cpuModel: TrimmedNonEmptyString,
  osVersion: TrimmedNonEmptyString,
  kernelRelease: TrimmedNonEmptyString,
});
export type HostMetricsAdministrativeDetails = typeof HostMetricsAdministrativeDetails.Type;

export const HostMetricsSnapshot = Schema.Struct({
  sampledAt: Schema.DateTimeUtc,
  sampleIntervalMs: NonNegativeInt,
  cpu: HostMetricsCpu,
  memory: HostMetricsMemory,
  storage: Schema.Array(HostMetricsStorage),
  phoenix: HostMetricsPhoenixFootprint,
  inventory: HostMetricsInventory,
  administrativeDetails: Schema.NullOr(HostMetricsAdministrativeDetails),
});
export type HostMetricsSnapshot = typeof HostMetricsSnapshot.Type;

export const HostMetricsHistorySample = Schema.Struct({
  sampledAt: Schema.DateTimeUtc,
  cpuUtilizationPercent: Schema.NullOr(Schema.Number),
  memoryUtilizationPercent: Schema.NullOr(Schema.Number),
});
export type HostMetricsHistorySample = typeof HostMetricsHistorySample.Type;

export const HostMetricsHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
});
export type HostMetricsHistoryInput = typeof HostMetricsHistoryInput.Type;

export const HostMetricsHistory = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  samples: Schema.Array(HostMetricsHistorySample),
});
export type HostMetricsHistory = typeof HostMetricsHistory.Type;

export const HostMetricsSubscriptionInput = Schema.Struct({
  sampleIntervalMs: Schema.Int.check(
    Schema.isBetween({
      minimum: HOST_METRICS_MIN_SAMPLE_INTERVAL_MS,
      maximum: HOST_METRICS_MAX_SAMPLE_INTERVAL_MS,
    }),
  ),
});
export type HostMetricsSubscriptionInput = typeof HostMetricsSubscriptionInput.Type;
