import {
  type EnvironmentId,
  ScheduleDetail,
  type ScheduleId,
  ScheduleListSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MobileDatabase } from "../../persistence/mobile-database";

const SCHEDULE_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION = 2;
const SNAPSHOT_CACHE_KEY = "snapshot";

const StoredScheduleSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEDULE_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  snapshot: ScheduleListSnapshot,
});

const StoredScheduleDetail = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  scheduleId: Schema.String,
  detail: ScheduleDetail,
});

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredScheduleSnapshot));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(StoredScheduleSnapshot));
const decodeDetail = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredScheduleDetail));
const encodeDetail = Schema.encodeEffect(Schema.fromJsonString(StoredScheduleDetail));

function detailCacheKey(scheduleId: ScheduleId): string {
  return `detail:${scheduleId}`;
}

export function makeScheduleCacheStore(database: MobileDatabase["Service"]) {
  const discardCorrupt = (environmentId: EnvironmentId, cacheKey: string, cause: unknown) =>
    Effect.logWarning("Discarding corrupt mobile Schedule cache record.", {
      environmentId,
      cacheKey,
      cause: String(cause),
    }).pipe(
      Effect.andThen(
        database
          .removeCache(environmentId, "schedule", cacheKey)
          .pipe(Effect.catch(() => Effect.void)),
      ),
      Effect.as(Option.none()),
    );

  return {
    loadSnapshot: (environmentId: EnvironmentId) =>
      database.loadCache(environmentId, "schedule", SNAPSHOT_CACHE_KEY).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<ScheduleListSnapshot>()),
            onSome: (raw) =>
              decodeSnapshot(raw).pipe(
                Effect.flatMap((stored) =>
                  stored.environmentId === environmentId
                    ? Effect.succeed(Option.some(stored.snapshot))
                    : Effect.succeed(Option.none()),
                ),
                Effect.catch((cause) => discardCorrupt(environmentId, SNAPSHOT_CACHE_KEY, cause)),
              ),
          }),
        ),
      ),
    saveSnapshot: (environmentId: EnvironmentId, snapshot: ScheduleListSnapshot) =>
      encodeSnapshot({
        schemaVersion: SCHEDULE_SNAPSHOT_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot,
      }).pipe(
        Effect.flatMap((payload) =>
          database.saveCache(
            environmentId,
            "schedule",
            SNAPSHOT_CACHE_KEY,
            SCHEDULE_SNAPSHOT_CACHE_SCHEMA_VERSION,
            payload,
          ),
        ),
      ),
    loadDetail: (environmentId: EnvironmentId, scheduleId: ScheduleId) => {
      const cacheKey = detailCacheKey(scheduleId);
      return database.loadCache(environmentId, "schedule", cacheKey).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<ScheduleDetail>()),
            onSome: (raw) =>
              decodeDetail(raw).pipe(
                Effect.flatMap((stored) =>
                  stored.environmentId === environmentId && stored.scheduleId === scheduleId
                    ? Effect.succeed(Option.some(stored.detail))
                    : Effect.succeed(Option.none()),
                ),
                Effect.catch((cause) => discardCorrupt(environmentId, cacheKey, cause)),
              ),
          }),
        ),
      );
    },
    saveDetail: (environmentId: EnvironmentId, detail: ScheduleDetail) =>
      encodeDetail({
        schemaVersion: SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION,
        environmentId,
        scheduleId: detail.id,
        detail,
      }).pipe(
        Effect.flatMap((payload) =>
          database.saveCache(
            environmentId,
            "schedule",
            detailCacheKey(detail.id),
            SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION,
            payload,
          ),
        ),
      ),
    removeDetail: (environmentId: EnvironmentId, scheduleId: ScheduleId) =>
      database.removeCache(environmentId, "schedule", detailCacheKey(scheduleId)),
    clear: (environmentId: EnvironmentId) => database.clearCacheKind(environmentId, "schedule"),
  };
}

export type ScheduleCacheStore = ReturnType<typeof makeScheduleCacheStore>;
