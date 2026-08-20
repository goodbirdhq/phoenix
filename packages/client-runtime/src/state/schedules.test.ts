import {
  EnvironmentId,
  OccurrenceId,
  ProjectId,
  ProviderInstanceId,
  ScheduleHistoryCursor,
  ScheduleId,
  type ScheduleDetail,
  type ScheduleListSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyScheduleListEvent,
  createScheduleEnvironmentAtoms,
  persistScheduleDetailIfNewer,
  removePersistedScheduleDetail,
} from "./schedules.ts";

const scheduleId = ScheduleId.make("schedule-1");
const schedule = {
  id: scheduleId,
  projectId: ProjectId.make("project-1"),
  name: "Daily review",
  timing: { type: "cron" as const, expression: "0 9 * * *" },
  timeZone: "Europe/Berlin",
  execution: {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceMode: "worktree" as const,
    baseBranch: "origin/HEAD",
  },
  state: "enabled" as const,
  nextOccurrenceAt: "2026-08-20T07:00:00.000Z",
  latestHistory: null,
  unacknowledgedFailure: false,
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
  revision: 1,
};

const snapshot: ScheduleListSnapshot = {
  sequence: 4,
  schedules: [schedule],
  updatedAt: "2026-08-19T10:00:00.000Z",
};

const environmentId = EnvironmentId.make("environment-1");
const detail: ScheduleDetail = {
  ...schedule,
  prompt: "Review the open pull requests",
  history: [],
  historyNextCursor: null,
};

describe("applyScheduleListEvent", () => {
  it("applies newer upserts and ignores duplicate or stale stream events", () => {
    const updated = {
      ...schedule,
      name: "Updated review",
      updatedAt: "2026-08-19T10:05:00.000Z",
      revision: 2,
    };
    const next = applyScheduleListEvent(snapshot, {
      type: "schedule-upserted",
      sequence: 5,
      schedule: updated,
    });

    expect(next.sequence).toBe(5);
    expect(next.schedules).toEqual([updated]);
    expect(
      applyScheduleListEvent(next, {
        type: "schedule-upserted",
        sequence: 5,
        schedule: { ...updated, name: "Stale replay" },
      }),
    ).toBe(next);
  });

  it("removes a Schedule without disturbing other rows", () => {
    const next = applyScheduleListEvent(snapshot, {
      type: "schedule-removed",
      sequence: 5,
      scheduleId,
    });

    expect(next).toEqual({
      sequence: 5,
      schedules: [],
      updatedAt: snapshot.updatedAt,
    });
  });

  it("accepts an authoritative reset and its timestamp", () => {
    const reset: ScheduleListSnapshot = {
      sequence: 1,
      schedules: [
        {
          ...schedule,
          latestHistory: {
            type: "failed",
            occurrenceId: OccurrenceId.make("01234567-89ab-cdef-0123-456789abcdef"),
            scheduledFor: "2026-08-19T09:00:00.000Z",
            failedAt: "2026-08-19T09:00:01.000Z",
            code: "trigger_failed",
            message: "Could not start Thread",
            count: 1,
            firstFailedAt: "2026-08-19T09:00:01.000Z",
            lastFailedAt: "2026-08-19T09:00:01.000Z",
          },
        },
      ],
      updatedAt: "2026-08-19T11:00:00.000Z",
    };

    expect(applyScheduleListEvent(snapshot, { type: "schedule-list-reset", snapshot: reset })).toBe(
      reset,
    );
  });
});

describe("persistScheduleDetailIfNewer", () => {
  it.effect("does not let a stale live response overwrite a newer cached revision", () =>
    Effect.gen(function* () {
      let stored = Option.none<ScheduleDetail>();
      const cache = {
        loadScheduleDetail: () => Effect.succeed(stored),
        saveScheduleDetail: (_environmentId: EnvironmentId, value: ScheduleDetail) =>
          Effect.sync(() => {
            stored = Option.some(value);
          }),
      };
      const newer = { ...detail, name: "Newest", revision: 3 };
      const stale = { ...detail, name: "Stale", revision: 2 };

      yield* persistScheduleDetailIfNewer(cache, environmentId, newer);
      yield* persistScheduleDetailIfNewer(cache, environmentId, stale);

      expect(Option.getOrThrow(stored)).toEqual(newer);
    }),
  );

  it.effect("does not let an in-flight stale response resurrect deleted cached detail", () =>
    Effect.gen(function* () {
      let stored = Option.some<ScheduleDetail>({ ...detail, revision: 2 });
      const cache = {
        loadScheduleDetail: () => Effect.succeed(stored),
        saveScheduleDetail: (_environmentId: EnvironmentId, value: ScheduleDetail) =>
          Effect.sync(() => {
            stored = Option.some(value);
          }),
        removeScheduleDetail: () =>
          Effect.sync(() => {
            stored = Option.none();
          }),
      };

      yield* removePersistedScheduleDetail(cache, environmentId, scheduleId, 3);
      yield* persistScheduleDetailIfNewer(cache, environmentId, {
        ...detail,
        name: "Stale response",
        revision: 2,
      });
      expect(Option.isNone(stored)).toBe(true);

      const recreated = { ...detail, name: "Recreated", revision: 4 };
      yield* persistScheduleDetailIfNewer(cache, environmentId, recreated);
      expect(Option.getOrThrow(stored)).toEqual(recreated);

      yield* removePersistedScheduleDetail(cache, environmentId, scheduleId, 3);
      expect(Option.getOrThrow(stored)).toEqual(recreated);
    }),
  );
});

describe("createScheduleEnvironmentAtoms", () => {
  it.effect("returns cached detail while its Environment is offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Offline environment",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        });
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          loadScheduleDetail: (_environmentId, requestedScheduleId) =>
            Effect.succeed(
              requestedScheduleId === scheduleId ? Option.some(detail) : Option.none(),
            ),
          clear: () => Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
            Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          ),
        );
        const atoms = createScheduleEnvironmentAtoms(runtime);
        const atom = atoms.detail({ environmentId, input: { scheduleId } });
        expect(atoms.detail({ environmentId, input: { scheduleId, revision: 1 } })).toBe(
          atoms.detail({ environmentId, input: { scheduleId, revision: 1 } }),
        );
        expect(atoms.detail({ environmentId, input: { scheduleId, revision: 2 } })).not.toBe(
          atoms.detail({ environmentId, input: { scheduleId, revision: 1 } }),
        );
        const olderCursor = ScheduleHistoryCursor.make("41");
        expect(
          atoms.history({ environmentId, input: { scheduleId, cursor: olderCursor, limit: 50 } }),
        ).toBe(
          atoms.history({ environmentId, input: { scheduleId, cursor: olderCursor, limit: 50 } }),
        );
        expect(
          atoms.history({ environmentId, input: { scheduleId, cursor: olderCursor, limit: 50 } }),
        ).not.toBe(atoms.history({ environmentId, input: { scheduleId, limit: 50 } }));
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const unmount = registry.mount(atom);

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const result = registry.get(atom);
        expect(AsyncResult.isSuccess(result)).toBe(true);
        if (AsyncResult.isSuccess(result)) expect(result.value).toEqual(detail);
        unmount();
      }),
    ),
  );
});
