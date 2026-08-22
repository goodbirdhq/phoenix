// @effect-diagnostics nodeBuiltinImport:off - host inventory and filesystem stats are the platform boundary this module owns.
import type {
  HostMetricsHistory,
  HostMetricsHistoryInput,
  HostMetricsHistorySample,
  HostMetricsSnapshot,
  HostMetricsStorage,
  HostMetricsSubscriptionInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import {
  HOST_METRICS_HISTORY_WINDOW_MS,
  HOST_METRICS_MIN_SAMPLE_INTERVAL_MS,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

const MINIMUM_COLLECTION_INTERVAL_MS = 750;
const STORAGE_COLLECTION_INTERVAL_MS = 10_000;

export interface CpuTimes {
  readonly busy: number;
  readonly idle: number;
  readonly total: number;
}

interface CpuState {
  readonly times: CpuTimes;
  readonly sampledAtMs: number;
}

export interface StorageReading {
  readonly device: bigint;
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface HostPlatformReading {
  readonly cpuTimes: CpuTimes | null;
  readonly logicalCpuCount: number;
  readonly cpuModel: string;
  readonly loadAverage: readonly [number, number, number] | null;
  readonly memory: {
    readonly totalBytes: number;
    readonly availableBytes: number;
    readonly availabilityKind: "available" | "free";
  } | null;
  readonly storage: ReadonlyArray<HostMetricsStorage>;
  readonly systemUptimeSeconds: number;
  readonly osVersion: string;
  readonly kernelRelease: string;
}

export class HostMetricsPlatform extends Context.Service<
  HostMetricsPlatform,
  {
    readonly read: Effect.Effect<HostPlatformReading>;
  }
>()("t3/hostMetrics/HostMetrics/HostMetricsPlatform") {}

export function sumCpuTimes(cpus: ReadonlyArray<NodeOS.CpuInfo>): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { busy: Math.max(0, total - idle), idle, total };
}

export function calculateCpuUtilization(
  previous: CpuTimes | null,
  current: CpuTimes,
): number | null {
  if (previous === null) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

export function parseLinuxMemAvailable(contents: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(contents);
  if (!match?.[1]) return null;
  const kibibytes = Number(match[1]);
  return Number.isFinite(kibibytes) ? kibibytes * 1_024 : null;
}

function percent(used: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (used / total) * 100));
}

async function readMemory(platform: NodeJS.Platform): Promise<HostPlatformReading["memory"]> {
  const totalBytes = NodeOS.totalmem();
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  if (platform === "linux") {
    try {
      const meminfo = await NodeFSP.readFile("/proc/meminfo", "utf8");
      const availableBytes = parseLinuxMemAvailable(meminfo);
      if (availableBytes !== null) {
        return {
          totalBytes,
          availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)),
          availabilityKind: "available",
        };
      }
    } catch {
      // Fall through to Node's portable free-memory reading.
    }
  }
  const freeBytes = NodeOS.freemem();
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) return null;
  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, freeBytes),
    availabilityKind: platform === "win32" ? "available" : "free",
  };
}

async function readStorage(path: string): Promise<StorageReading | null> {
  try {
    const [filesystem, pathStat] = await Promise.all([
      NodeFSP.statfs(path, { bigint: true }),
      NodeFSP.stat(path, { bigint: true }),
    ]);
    const totalBytes = Number(filesystem.blocks * filesystem.bsize);
    const availableBytes = Number(filesystem.bavail * filesystem.bsize);
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
    return {
      device: pathStat.dev,
      totalBytes,
      availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)),
    };
  } catch {
    return null;
  }
}

function availableStorage(
  kind: "server" | "phoenix" | "shared",
  reading: StorageReading,
): HostMetricsStorage {
  const usedBytes = Math.max(0, reading.totalBytes - reading.availableBytes);
  return {
    kind,
    status: "available",
    totalBytes: reading.totalBytes,
    availableBytes: reading.availableBytes,
    usedBytes,
    utilizationPercent: percent(usedBytes, reading.totalBytes),
  };
}

function unavailableStorage(kind: "server" | "phoenix"): HostMetricsStorage {
  return { kind, status: "unavailable", reason: "Storage metrics unavailable." };
}

export function resolveStorageMetrics(
  server: StorageReading | null,
  phoenix: StorageReading | null,
): ReadonlyArray<HostMetricsStorage> {
  if (server !== null && phoenix !== null && server.device === phoenix.device) {
    return [availableStorage("shared", server)];
  }
  return [
    server === null ? unavailableStorage("server") : availableStorage("server", server),
    phoenix === null ? unavailableStorage("phoenix") : availableStorage("phoenix", phoenix),
  ];
}

async function readStorageMetrics(cwd: string, baseDir: string) {
  const [server, phoenix] = await Promise.all([readStorage(cwd), readStorage(baseDir)]);
  return resolveStorageMetrics(server, phoenix);
}

const makePlatform = Effect.fn("hostMetrics.hostMetricsPlatform.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const hostPlatform = yield* HostProcessPlatform;
  const storageCache = yield* Ref.make<{
    readonly sampledAtMs: number;
    readonly storage: ReadonlyArray<HostMetricsStorage>;
  } | null>(null);
  const read = Effect.gen(function* () {
    const sampledAtMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cachedStorage = yield* Ref.get(storageCache);
    const storage =
      cachedStorage !== null &&
      sampledAtMs - cachedStorage.sampledAtMs < STORAGE_COLLECTION_INTERVAL_MS
        ? cachedStorage.storage
        : yield* Effect.promise(() => readStorageMetrics(config.cwd, config.baseDir)).pipe(
            Effect.tap((next) => Ref.set(storageCache, { sampledAtMs, storage: next })),
          );
    const cpus = NodeOS.cpus();
    const memory = yield* Effect.promise(() => readMemory(hostPlatform));
    const loadAverage = NodeOS.loadavg();
    return {
      cpuTimes: cpus.length === 0 ? null : sumCpuTimes(cpus),
      logicalCpuCount: cpus.length,
      cpuModel: cpus[0]?.model.trim() || "Unknown CPU",
      loadAverage:
        hostPlatform === "win32"
          ? null
          : ([loadAverage[0] ?? 0, loadAverage[1] ?? 0, loadAverage[2] ?? 0] as const),
      memory,
      storage,
      systemUptimeSeconds: Math.max(0, Math.floor(NodeOS.uptime())),
      osVersion: NodeOS.version().trim() || NodeOS.type(),
      kernelRelease: NodeOS.release().trim() || "Unknown",
    };
  });
  return HostMetricsPlatform.of({ read });
});

export const platformLayer = Layer.effect(HostMetricsPlatform, makePlatform());

function phoenixFootprint(
  telemetry: ResourceTelemetrySnapshot,
  logicalCpuCount: number,
  totalMemoryBytes: number,
): HostMetricsSnapshot["phoenix"] {
  const aggregate = telemetry.groups.allT3;
  return {
    cpuCorePercent: aggregate.currentCpuPercent,
    cpuMachinePercent:
      logicalCpuCount > 0
        ? Math.min(100, Math.max(0, aggregate.currentCpuPercent / logicalCpuCount))
        : null,
    residentBytes: aggregate.currentRssBytes,
    memoryMachinePercent:
      totalMemoryBytes > 0 ? percent(aggregate.currentRssBytes, totalMemoryBytes) : null,
    processCount: aggregate.processCount,
    ioReadBytesPerSecond: aggregate.ioReadBytesPerSecond,
    ioWriteBytesPerSecond: aggregate.ioWriteBytesPerSecond,
    sourceStatus: telemetry.health.native.status,
  };
}

function redactAdministrativeDetails(
  snapshot: HostMetricsSnapshot,
  includeAdministrativeDetails: boolean,
): HostMetricsSnapshot {
  return includeAdministrativeDetails ? snapshot : { ...snapshot, administrativeDetails: null };
}

interface LiveState {
  readonly retainCount: number;
  readonly scope: Option.Option<Scope.Closeable>;
}

export class HostMetrics extends Context.Service<
  HostMetrics,
  {
    readonly read: (includeAdministrativeDetails: boolean) => Effect.Effect<HostMetricsSnapshot>;
    readonly subscribe: (
      input: HostMetricsSubscriptionInput,
      includeAdministrativeDetails: boolean,
    ) => Effect.Effect<
      {
        readonly latest: HostMetricsSnapshot;
        readonly changes: Stream.Stream<HostMetricsSnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly readHistory: (input: HostMetricsHistoryInput) => Effect.Effect<HostMetricsHistory>;
  }
>()("t3/hostMetrics/HostMetrics") {}

export const make = Effect.fn("hostMetrics.hostMetrics.make")(function* () {
  const platform = yield* HostMetricsPlatform;
  const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const sampleMutex = yield* Semaphore.make(1);
  const liveMutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<HostMetricsSnapshot>(8);
  const cpuState = yield* Ref.make<CpuState | null>(null);
  const latest = yield* Ref.make<Option.Option<HostMetricsSnapshot>>(Option.none());
  const history = yield* Ref.make<ReadonlyArray<HostMetricsHistorySample>>([]);
  const liveState = yield* Ref.make<LiveState>({ retainCount: 0, scope: Option.none() });

  const collectFresh = Effect.fn("hostMetrics.hostMetrics.collectFresh")(function* (
    minimumAgeMs: number,
    refreshProcessTelemetry: boolean,
    publish: boolean,
  ) {
    return yield* sampleMutex.withPermits(1)(
      Effect.gen(function* () {
        const sampledAt = yield* DateTime.now;
        const sampledAtMs = DateTime.toEpochMillis(sampledAt);
        const currentLatest = yield* Ref.get(latest);
        if (
          Option.isSome(currentLatest) &&
          sampledAtMs - DateTime.toEpochMillis(currentLatest.value.sampledAt) < minimumAgeMs
        ) {
          return currentLatest.value;
        }

        const telemetry = refreshProcessTelemetry
          ? yield* resourceTelemetry.refresh.pipe(Effect.catch(() => resourceTelemetry.latest))
          : yield* resourceTelemetry.latest;
        const reading = yield* platform.read;
        const previousCpu = yield* Ref.get(cpuState);
        const utilizationPercent =
          reading.cpuTimes === null
            ? null
            : calculateCpuUtilization(previousCpu?.times ?? null, reading.cpuTimes);
        if (reading.cpuTimes === null) {
          yield* Ref.set(cpuState, null);
        } else {
          yield* Ref.set(cpuState, { times: reading.cpuTimes, sampledAtMs });
        }
        const cpuStatus =
          reading.cpuTimes === null
            ? ("unavailable" as const)
            : utilizationPercent === null
              ? ("warming" as const)
              : ("available" as const);

        const memory =
          telemetry.hostMemory === undefined || telemetry.health.native.status !== "healthy"
            ? reading.memory
            : {
                ...telemetry.hostMemory,
                availabilityKind: "available" as const,
              };
        const availableBytes = memory?.availableBytes ?? 0;
        const totalMemoryBytes = memory?.totalBytes ?? 0;
        const usedBytes = Math.max(0, totalMemoryBytes - availableBytes);
        const sampleIntervalMs =
          previousCpu === null ? 0 : Math.max(0, sampledAtMs - previousCpu.sampledAtMs);
        const snapshot: HostMetricsSnapshot = {
          sampledAt,
          sampleIntervalMs,
          cpu: {
            status: cpuStatus,
            statusReason:
              cpuStatus === "unavailable"
                ? "CPU metrics unavailable."
                : cpuStatus === "warming"
                  ? "Collecting a CPU baseline."
                  : null,
            utilizationPercent: cpuStatus === "available" ? utilizationPercent : null,
            loadAverage1m: reading.loadAverage?.[0] ?? null,
            loadAverage5m: reading.loadAverage?.[1] ?? null,
            loadAverage15m: reading.loadAverage?.[2] ?? null,
          },
          memory: {
            status: memory === null ? "unavailable" : "available",
            statusReason: memory === null ? "Memory metrics unavailable." : null,
            availabilityKind: memory?.availabilityKind ?? "free",
            totalBytes: totalMemoryBytes,
            availableBytes,
            usedBytes,
            utilizationPercent: percent(usedBytes, totalMemoryBytes),
          },
          storage: reading.storage,
          phoenix: phoenixFootprint(telemetry, reading.logicalCpuCount, totalMemoryBytes),
          inventory: {
            logicalCpuCount: reading.logicalCpuCount,
            totalMemoryBytes,
            systemUptimeSeconds: reading.systemUptimeSeconds,
            serverUptimeSeconds: Math.max(0, Math.floor(process.uptime())),
          },
          administrativeDetails: {
            cpuModel: reading.cpuModel,
            osVersion: reading.osVersion,
            kernelRelease: reading.kernelRelease,
          },
        };

        const historySample: HostMetricsHistorySample = {
          sampledAt,
          cpuUtilizationPercent: snapshot.cpu.utilizationPercent,
          memoryUtilizationPercent:
            snapshot.memory.status === "available" &&
            snapshot.memory.availabilityKind === "available"
              ? snapshot.memory.utilizationPercent
              : null,
        };
        yield* Ref.update(history, (samples) => {
          const cutoff = sampledAtMs - HOST_METRICS_HISTORY_WINDOW_MS;
          return [
            ...samples.filter((sample) => DateTime.toEpochMillis(sample.sampledAt) >= cutoff),
            historySample,
          ];
        });
        yield* Ref.set(latest, Option.some(snapshot));
        if (publish) yield* PubSub.publish(changes, snapshot);
        return snapshot;
      }),
    );
  });

  const latestOrCollect = Ref.get(latest).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => collectFresh(0, false, false),
        onSome: Effect.succeed,
      }),
    ),
  );

  const liveLoop = Effect.sleep(HOST_METRICS_MIN_SAMPLE_INTERVAL_MS).pipe(
    Effect.andThen(collectFresh(MINIMUM_COLLECTION_INTERVAL_MS, false, true)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Host metrics sample failed", { cause: String(cause) }),
    ),
    Effect.forever,
  );

  const acquireLive = liveMutex.withPermits(1)(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = yield* Ref.get(liveState);
        if (current.retainCount > 0) {
          yield* Ref.set(liveState, { ...current, retainCount: current.retainCount + 1 });
          return;
        }
        const scope = yield* Scope.make();
        const processSubscription = yield* resourceTelemetry.subscribe.pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* processSubscription.changes.pipe(Stream.runDrain, Effect.forkIn(scope));
        yield* collectFresh(MINIMUM_COLLECTION_INTERVAL_MS, false, false);
        yield* liveLoop.pipe(Effect.forkIn(scope));
        yield* Ref.set(liveState, { retainCount: 1, scope: Option.some(scope) });
      }),
    ),
  );

  const releaseLive = liveMutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(liveState);
      if (current.retainCount <= 1) {
        yield* Ref.set(liveState, { retainCount: 0, scope: Option.none() });
        if (Option.isSome(current.scope)) {
          yield* Scope.close(current.scope.value, Exit.void).pipe(Effect.ignore);
        }
        return;
      }
      yield* Ref.set(liveState, { ...current, retainCount: current.retainCount - 1 });
    }),
  );

  const read: HostMetrics["Service"]["read"] = (includeAdministrativeDetails) =>
    Ref.get(liveState).pipe(
      Effect.flatMap((state) =>
        collectFresh(MINIMUM_COLLECTION_INTERVAL_MS, state.retainCount === 0, false),
      ),
      Effect.map((snapshot) => redactAdministrativeDetails(snapshot, includeAdministrativeDetails)),
    );

  const subscribe: HostMetrics["Service"]["subscribe"] = (input, includeAdministrativeDetails) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(acquireLive, () => releaseLive);
      const subscription = yield* subscribeBeforeSnapshot(changes, latestOrCollect, sampleMutex);
      let lastEmittedAtMs = DateTime.toEpochMillis(subscription.latest.sampledAt);
      const redactedLatest = redactAdministrativeDetails(
        subscription.latest,
        includeAdministrativeDetails,
      );
      const redactedChanges = subscription.changes.pipe(
        Stream.filter((snapshot) => {
          const sampledAtMs = DateTime.toEpochMillis(snapshot.sampledAt);
          if (sampledAtMs - lastEmittedAtMs < input.sampleIntervalMs) return false;
          lastEmittedAtMs = sampledAtMs;
          return true;
        }),
        Stream.map((snapshot) =>
          redactAdministrativeDetails(snapshot, includeAdministrativeDetails),
        ),
      );
      return { latest: redactedLatest, changes: redactedChanges };
    });

  const readHistory: HostMetrics["Service"]["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const windowMs = Math.min(HOST_METRICS_HISTORY_WINDOW_MS, Math.max(0, input.windowMs));
      const cutoff = DateTime.toEpochMillis(readAt) - windowMs;
      const samples = (yield* Ref.get(history)).filter(
        (sample) => DateTime.toEpochMillis(sample.sampledAt) >= cutoff,
      );
      return { readAt, windowMs, samples };
    });

  return HostMetrics.of({ read, subscribe, readHistory });
});

export const layer = Layer.effect(HostMetrics, make()).pipe(Layer.provide(platformLayer));
