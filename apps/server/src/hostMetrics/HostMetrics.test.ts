import { describe, expect, it } from "@effect/vitest";
import type { ResourceTelemetryAggregate, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import {
  calculateCpuUtilization,
  HostMetrics,
  HostMetricsPlatform,
  make,
  parseLinuxMemAvailable,
  resolveStorageMetrics,
} from "./HostMetrics.ts";

const emptyAggregate: ResourceTelemetryAggregate = {
  processCount: 2,
  currentCpuPercent: 25,
  cpuTimeMs: 1_000,
  currentRssBytes: 256 * 1_024 ** 2,
  peakRssBytes: 300 * 1_024 ** 2,
  ioReadBytes: 100,
  ioWriteBytes: 200,
  ioReadBytesPerSecond: 10,
  ioWriteBytesPerSecond: 20,
  processStarts: 2,
  processExits: 0,
};

function resourceSnapshot(
  hostMemory?: ResourceTelemetrySnapshot["hostMemory"],
  nativeStatus: ResourceTelemetrySnapshot["health"]["native"]["status"] = "healthy",
): ResourceTelemetrySnapshot {
  const readAt = DateTime.makeUnsafe("2026-08-22T12:00:00.000Z");
  return {
    readAt,
    sampleIntervalMs: 1_000,
    processes: [],
    groups: {
      backend: emptyAggregate,
      electron: { ...emptyAggregate, processCount: 0 },
      monitor: { ...emptyAggregate, processCount: 1 },
      allT3: emptyAggregate,
    },
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: readAt,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt, entries: [] },
    health: {
      native: { status: nativeStatus, lastSampleAt: Option.some(readAt), lastError: Option.none() },
      desktop: { status: "stopped", lastSampleAt: Option.none(), lastError: Option.none() },
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 100,
      scannedProcessCount: 2,
      retainedProcessCount: 2,
      inaccessibleProcessCount: 0,
    },
    ...(hostMemory === undefined ? {} : { hostMemory }),
  };
}

function makeTestLayer(options?: {
  readonly cpuTimesForRead?: (count: number) => { busy: number; idle: number; total: number };
  readonly hostMemory?: ResourceTelemetrySnapshot["hostMemory"];
  readonly nativeStatus?: ResourceTelemetrySnapshot["health"]["native"]["status"];
}) {
  return Effect.gen(function* () {
    const platformReads = yield* Ref.make(0);
    const telemetryRetains = yield* Ref.make(0);
    const telemetry = resourceSnapshot(options?.hostMemory, options?.nativeStatus);
    const platformLayer = Layer.succeed(
      HostMetricsPlatform,
      HostMetricsPlatform.of({
        read: Ref.updateAndGet(platformReads, (count) => count + 1).pipe(
          Effect.map((count) => ({
            cpuTimes: options?.cpuTimesForRead?.(count) ?? {
              busy: count * 500,
              idle: count * 500,
              total: count * 1_000,
            },
            logicalCpuCount: 4,
            cpuModel: "Test CPU",
            loadAverage: [0.5, 0.4, 0.3] as const,
            memory: {
              totalBytes: 8 * 1_024 ** 3,
              availableBytes: 4 * 1_024 ** 3,
              availabilityKind: "available" as const,
            },
            storage: resolveStorageMetrics(
              { device: 1n, totalBytes: 100, availableBytes: 50 },
              { device: 1n, totalBytes: 100, availableBytes: 50 },
            ),
            systemUptimeSeconds: 3_600,
            osVersion: "Test OS",
            kernelRelease: "1.0",
          })),
        ),
      }),
    );
    const resourceLayer = Layer.succeed(
      ResourceTelemetry.ResourceTelemetry,
      ResourceTelemetry.ResourceTelemetry.of({
        latest: Effect.succeed(telemetry),
        changes: Stream.empty,
        subscribe: Effect.acquireRelease(
          Ref.update(telemetryRetains, (count) => count + 1),
          () => Ref.update(telemetryRetains, (count) => count - 1),
        ).pipe(Effect.as({ latest: telemetry, changes: Stream.empty })),
        readHistory: () => Effect.die("unused"),
        refresh: Effect.succeed(telemetry),
        validateProcessIdentity: () => Effect.die("unused"),
        retry: Effect.die("unused"),
      }),
    );
    return {
      layer: Layer.effect(HostMetrics, make()).pipe(
        Layer.provide(Layer.merge(platformLayer, resourceLayer)),
      ),
      platformReads,
      telemetryRetains,
    };
  });
}

describe("HostMetrics", () => {
  it("calculates normalized host CPU utilization from cumulative samples", () => {
    expect(
      calculateCpuUtilization(
        { busy: 600, idle: 400, total: 1_000 },
        { busy: 780, idle: 420, total: 1_200 },
      ),
    ).toBe(90);
  });

  it("waits for a second CPU sample before reporting utilization", () => {
    expect(calculateCpuUtilization(null, { busy: 600, idle: 400, total: 1_000 })).toBeNull();
  });

  it("uses Linux MemAvailable rather than cache-hostile free memory", () => {
    expect(
      parseLinuxMemAvailable(
        [
          "MemTotal:       16384000 kB",
          "MemFree:         1000000 kB",
          "MemAvailable:    8192000 kB",
        ].join("\n"),
      ),
    ).toBe(8_388_608_000);
  });

  it("rejects malformed Linux memory readings", () => {
    expect(parseLinuxMemAvailable("MemFree: 10 kB")).toBeNull();
  });

  it("deduplicates shared storage devices and preserves unavailable states", () => {
    expect(
      resolveStorageMetrics(
        { device: 1n, totalBytes: 100, availableBytes: 25 },
        { device: 1n, totalBytes: 100, availableBytes: 25 },
      ),
    ).toEqual([
      {
        kind: "shared",
        status: "available",
        totalBytes: 100,
        availableBytes: 25,
        usedBytes: 75,
        utilizationPercent: 75,
      },
    ]);
    expect(resolveStorageMetrics(null, null)).toEqual([
      { kind: "server", status: "unavailable", reason: "Storage metrics unavailable." },
      { kind: "phoenix", status: "unavailable", reason: "Storage metrics unavailable." },
    ]);
  });

  it.effect("coalesces concurrent reads behind one CPU baseline", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer();
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const metrics = yield* HostMetrics;
        const first = yield* Effect.all([metrics.read(false), metrics.read(false)], {
          concurrency: "unbounded",
        });
        expect(yield* Ref.get(test.platformReads)).toBe(1);
        expect(first.map((snapshot) => snapshot.cpu.status)).toEqual(["warming", "warming"]);

        yield* TestClock.adjust("1 second");
        const second = yield* Effect.all([metrics.read(false), metrics.read(false)], {
          concurrency: "unbounded",
        });
        expect(yield* Ref.get(test.platformReads)).toBe(2);
        expect(second.map((snapshot) => snapshot.cpu.utilizationPercent)).toEqual([50, 50]);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("records an invalid CPU delta as warming instead of extending stale utilization", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        cpuTimesForRead: (count) =>
          count < 3
            ? { busy: count * 500, idle: count * 500, total: count * 1_000 }
            : { busy: 1_000, idle: 1_000, total: 2_000 },
      });
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const metrics = yield* HostMetrics;
        yield* metrics.read(false);
        yield* TestClock.adjust("1 second");
        expect((yield* metrics.read(false)).cpu.utilizationPercent).toBe(50);
        yield* TestClock.adjust("1 second");
        const invalid = yield* metrics.read(false);
        expect(invalid.cpu.status).toBe("warming");
        expect(invalid.cpu.utilizationPercent).toBeNull();
        expect((yield* metrics.readHistory({ windowMs: 10_000 })).samples.at(-1)).toMatchObject({
          cpuUtilizationPercent: null,
        });
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("prefers cross-platform available memory from the native collector", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        hostMemory: {
          totalBytes: 8 * 1_024 ** 3,
          availableBytes: 6 * 1_024 ** 3,
        },
      });
      yield* Effect.gen(function* () {
        const snapshot = yield* (yield* HostMetrics).read(false);
        expect(snapshot.memory).toMatchObject({
          status: "available",
          availabilityKind: "available",
          availableBytes: 6 * 1_024 ** 3,
          utilizationPercent: 25,
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("falls back to the platform reading when native memory becomes stale", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer({
        hostMemory: {
          totalBytes: 8 * 1_024 ** 3,
          availableBytes: 6 * 1_024 ** 3,
        },
        nativeStatus: "unavailable",
      });
      yield* Effect.gen(function* () {
        const snapshot = yield* (yield* HostMetrics).read(false);
        expect(snapshot.memory).toMatchObject({
          status: "available",
          availableBytes: 4 * 1_024 ** 3,
          utilizationPercent: 50,
        });
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("shares one one-second sampler and releases it with the final subscriber", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer();
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const metrics = yield* HostMetrics;
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        yield* metrics
          .subscribe({ sampleIntervalMs: 1_000 }, false)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const secondSubscription = yield* metrics
          .subscribe({ sampleIntervalMs: 1_000 }, false)
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        const samplesFiber = yield* secondSubscription.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        expect(yield* Ref.get(test.telemetryRetains)).toBe(1);
        expect(yield* Ref.get(test.platformReads)).toBe(1);

        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(samplesFiber)).length).toBe(2);
        expect(yield* Ref.get(test.platformReads)).toBe(3);

        yield* Scope.close(firstScope, Exit.void);
        expect(yield* Ref.get(test.telemetryRetains)).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(test.platformReads)).toBe(4);

        yield* Scope.close(secondScope, Exit.void);
        expect(yield* Ref.get(test.telemetryRetains)).toBe(0);
        yield* TestClock.adjust("2 seconds");
        expect(yield* Ref.get(test.platformReads)).toBe(4);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("redacts administrative inventory and prunes history to the requested window", () =>
    Effect.gen(function* () {
      const test = yield* makeTestLayer();
      yield* TestClock.setTime(0);
      yield* Effect.gen(function* () {
        const metrics = yield* HostMetrics;
        expect((yield* metrics.read(false)).administrativeDetails).toBeNull();
        expect((yield* metrics.read(true)).administrativeDetails?.cpuModel).toBe("Test CPU");

        yield* TestClock.adjust("10 minutes");
        yield* metrics.read(false);
        yield* TestClock.adjust("10 minutes");
        yield* metrics.read(false);
        const history = yield* metrics.readHistory({ windowMs: 15 * 60 * 1_000 });
        expect(history.samples).toHaveLength(2);
        expect(history.windowMs).toBe(15 * 60 * 1_000);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
