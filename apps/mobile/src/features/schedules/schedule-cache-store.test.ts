import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  type ScheduleDetail,
  type ScheduleListSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MobileDatabase } from "../../persistence/mobile-database";
import { makeScheduleCacheStore } from "./schedule-cache-store";

const environmentId = EnvironmentId.make("environment-1");
const scheduleId = ScheduleId.make("schedule-1");

function summary() {
  return {
    id: scheduleId,
    projectId: ProjectId.make("project-1"),
    name: "Morning review",
    timing: { type: "cron", expression: "0 9 * * 1-5" },
    timeZone: "Europe/Berlin",
    execution: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "worktree",
      baseBranch: "origin/HEAD",
    },
    state: "enabled",
    nextOccurrenceAt: "2026-08-20T07:00:00.000Z",
    latestHistory: null,
    unacknowledgedFailure: false,
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    revision: 0,
  } as const;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const removed: string[] = [];
  const key = (kind: string, cacheKey: string) => `${environmentId}:${kind}:${cacheKey}`;
  return {
    values,
    removed,
    service: MobileDatabase.of({
      loadCache: (_environmentId, kind, cacheKey) =>
        Effect.succeed(Option.fromNullishOr(values.get(key(kind, cacheKey)))),
      saveCache: (_environmentId, kind, cacheKey, _schemaVersion, payload) =>
        Effect.sync(() => void values.set(key(kind, cacheKey), payload)),
      removeCache: (_environmentId, kind, cacheKey) =>
        Effect.sync(() => {
          removed.push(key(kind, cacheKey));
          values.delete(key(kind, cacheKey));
        }),
      clearCacheKind: (_environmentId, kind) =>
        Effect.sync(() => {
          for (const candidate of values.keys()) {
            if (candidate.startsWith(`${environmentId}:${kind}:`)) values.delete(candidate);
          }
        }),
      clearEnvironmentCache: () => Effect.void,
      clearAllCaches: Effect.void,
      inspectCaches: Effect.succeed([]),
      loadPreferencesJson: Effect.succeed(Option.none()),
      savePreferencesJson: () => Effect.void,
    }),
  };
}

describe("mobile Schedule cache", () => {
  it.effect("restores the last list and opened details for an offline Environment", () =>
    Effect.gen(function* () {
      const database = makeDatabase();
      const cache = makeScheduleCacheStore(database.service);
      const snapshot: ScheduleListSnapshot = {
        sequence: 7,
        schedules: [summary()],
        updatedAt: "2026-08-19T10:00:00.000Z",
      };
      const detail: ScheduleDetail = {
        ...summary(),
        prompt: "Review open pull requests",
        history: [],
        historyNextCursor: null,
      };

      yield* cache.saveSnapshot(environmentId, snapshot);
      yield* cache.saveDetail(environmentId, detail);

      expect(Option.getOrNull(yield* cache.loadSnapshot(environmentId))).toEqual(snapshot);
      expect(Option.getOrNull(yield* cache.loadDetail(environmentId, scheduleId))).toEqual(detail);
    }),
  );

  it.effect("discards a corrupt record instead of presenting it as Schedule state", () =>
    Effect.gen(function* () {
      const database = makeDatabase();
      database.values.set(`${environmentId}:schedule:snapshot`, "{bad json");
      const cache = makeScheduleCacheStore(database.service);

      expect(Option.isNone(yield* cache.loadSnapshot(environmentId))).toBe(true);
      expect(database.removed).toEqual([`${environmentId}:schedule:snapshot`]);
    }),
  );

  it.effect("discards pre-pagination detail records while retaining the bounded list cache", () =>
    Effect.gen(function* () {
      const database = makeDatabase();
      const cacheKey = `${environmentId}:schedule:detail:${scheduleId}`;
      database.values.set(
        cacheKey,
        JSON.stringify({
          schemaVersion: 1,
          environmentId,
          scheduleId,
          detail: { ...summary(), prompt: "Old detail", history: [] },
        }),
      );
      const cache = makeScheduleCacheStore(database.service);

      expect(Option.isNone(yield* cache.loadDetail(environmentId, scheduleId))).toBe(true);
      expect(database.removed).toEqual([cacheKey]);
    }),
  );
});
