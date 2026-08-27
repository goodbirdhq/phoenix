import {
  CommandId,
  ScheduleCommand as ScheduleCommandSchema,
  ScheduleDomainEvent,
  OccurrenceId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
  TurnId,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as ThreadTurnBootstrap from "../orchestration/ThreadTurnBootstrap.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { ScheduleService } from "./ScheduleService.ts";
import * as Schedules from "./ScheduleService.ts";
import { evolveScheduleDefinition } from "./ScheduleDomain.ts";

type ThreadTurnStartCommand = ThreadTurnBootstrap.ThreadTurnStartCommand;

const encodeScheduleCommandJson = Schema.encodeEffect(Schema.fromJsonString(ScheduleCommandSchema));

class RecordedLaunches extends Context.Service<
  RecordedLaunches,
  {
    readonly record: (command: ThreadTurnStartCommand) => Effect.Effect<void>;
    readonly recordCleanup: (threadId: ThreadId) => Effect.Effect<void>;
    readonly read: Effect.Effect<ReadonlyArray<ThreadTurnStartCommand>>;
    readonly readCleanups: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly blockNext: Effect.Effect<{
      readonly recorded: Effect.Effect<void>;
      readonly release: Effect.Effect<void>;
    }>;
    readonly clear: Effect.Effect<void>;
  }
>()("t3/schedule/ScheduleService.test/RecordedLaunches") {}

class ProviderSnapshots extends Context.Service<
  ProviderSnapshots,
  {
    readonly read: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly set: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  }
>()("t3/schedule/ScheduleService.test/ProviderSnapshots") {}

const availableProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  availability: "available",
  models: [
    {
      slug: "gpt-5.6-codex",
      name: "GPT-5.6 Codex",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

const providerSnapshotsLayer = Layer.effect(
  ProviderSnapshots,
  Effect.gen(function* () {
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([availableProvider]);
    return ProviderSnapshots.of({
      read: Ref.get(providers),
      set: (next) => Ref.set(providers, next),
    });
  }),
);

const providerRegistryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const providers = yield* ProviderSnapshots;
    return Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: providers.read,
    });
  }),
).pipe(Layer.provideMerge(providerSnapshotsLayer));

const recordedLaunchesLayer = Layer.effect(
  RecordedLaunches,
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadTurnStartCommand>>([]);
    const cleanups = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const nextGate = yield* Ref.make<{
      readonly recorded: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null>(null);
    return RecordedLaunches.of({
      record: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(launches, (current) => [...current, command]);
          const gate = yield* Ref.getAndSet(nextGate, null);
          if (gate !== null) {
            yield* Deferred.succeed(gate.recorded, undefined);
            yield* Deferred.await(gate.release);
          }
        }),
      recordCleanup: (threadId) => Ref.update(cleanups, (current) => [...current, threadId]),
      read: Ref.get(launches),
      readCleanups: Ref.get(cleanups),
      blockNext: Effect.gen(function* () {
        const recorded = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(nextGate, { recorded, release });
        return {
          recorded: Deferred.await(recorded),
          release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
        };
      }),
      clear: Effect.all([
        Ref.set(launches, []),
        Ref.set(cleanups, []),
        Ref.set(nextGate, null),
      ]).pipe(Effect.asVoid),
    });
  }),
);

const threadBootstrapLayer = Layer.effect(
  ThreadTurnBootstrap.ThreadTurnBootstrap,
  Effect.gen(function* () {
    const launches = yield* RecordedLaunches;
    return ThreadTurnBootstrap.ThreadTurnBootstrap.of({
      bootstrapTurnStart: (command) =>
        command.bootstrap?.prepareWorktree?.baseBranch === "missing"
          ? Effect.fail(
              new OrchestrationDispatchCommandError({
                message: "Git ref missing does not exist.",
              }),
            )
          : launches.record(command).pipe(Effect.as({ sequence: 1 })),
      cleanupRecoveredThread: launches.recordCleanup,
    });
  }),
).pipe(Layer.provideMerge(recordedLaunchesLayer));

const gitWorkflowLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
  localStatus: ({ cwd }) =>
    Effect.succeed({
      isRepo: cwd !== "/tmp/not-git",
      hasPrimaryRemote: false,
      isDefaultRef: true,
      refName: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
});

const projectionQueryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
);

const serviceLayer = Schedules.layer.pipe(
  Layer.provideMerge(projectionQueryLayer),
  Layer.provideMerge(threadBootstrapLayer),
  Layer.provideMerge(providerRegistryLayer),
  Layer.provideMerge(gitWorkflowLayer),
);

const layer = it.layer(
  Layer.mergeAll(
    serviceLayer,
    ProjectionProjectRepositoryLive,
    ProjectionThreadRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer)),
);

const projectId = ProjectId.make("schedule-project");
const scheduleId = ScheduleId.make("schedule-one-time");
const execution = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-codex",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceMode: "local" as const,
  baseBranch: null,
};

const seedProject = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const launches = yield* RecordedLaunches;
  const providers = yield* ProviderSnapshots;
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(0);
  yield* sql`DELETE FROM schedule_commands`;
  yield* sql`DELETE FROM schedule_events`;
  yield* sql`DELETE FROM schedule_occurrences`;
  yield* sql`DELETE FROM schedule_history`;
  yield* sql`DELETE FROM schedule_definitions`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* launches.clear;
  yield* providers.set([availableProvider]);
  yield* projects.upsert({
    projectId,
    title: "Schedule project",
    workspaceRoot: "/tmp/schedule-project",
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  });
});

layer("ScheduleService", (it) => {
  it.effect("durably projects a one-time Schedule and records its fresh-thread launch", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      yield* seedProject;

      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("schedule-create-command"),
        scheduleId,
        projectId,
        name: "Check the build",
        prompt: "Inspect the latest build and report failures.",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "Europe/Berlin",
        execution,
        state: "enabled",
      });

      const before = yield* schedules.getSnapshot();
      assert.strictEqual(before.schedules.length, 1);
      assert.strictEqual(before.schedules[0]?.nextOccurrenceAt, "1970-01-01T00:05:00.000Z");
      assert.strictEqual((yield* launches.read).length, 0);

      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      const after = yield* schedules.getDetail(scheduleId);
      assert.strictEqual(after.state, "completed");
      assert.strictEqual(after.nextOccurrenceAt, null);
      assert.strictEqual(after.history.length, 1);
      assert.strictEqual(after.history[0]?.type, "triggered");

      const recorded = yield* launches.read;
      assert.strictEqual(recorded.length, 1);
      const launch = recorded[0];
      if (
        launch === undefined ||
        launch.bootstrap === undefined ||
        launch.bootstrap.createThread === undefined
      ) {
        return yield* Effect.die("Expected a recorded bootstrap launch.");
      }
      assert.strictEqual(
        launch.threadId,
        `schedule:${after.history[0]?.type === "triggered" ? after.history[0].occurrenceId : ""}`,
      );
      assert.strictEqual(launch.message.text, "Inspect the latest build and report failures.");
      assert.strictEqual(launch.bootstrap.createThread.projectId, projectId);
      assert.isUndefined(launch.bootstrap.prepareWorktree);
    }),
  );

  it.effect("edits a completed one-time Schedule without re-enabling its past Occurrence", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      yield* seedProject;

      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-completed-edit"),
        scheduleId: ScheduleId.make("completed-edit"),
        projectId,
        name: "Before completion",
        prompt: "run once",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      yield* schedules.dispatch({
        type: "schedule.update",
        commandId: CommandId.make("edit-completed-definition"),
        scheduleId: ScheduleId.make("completed-edit"),
        projectId,
        name: "After completion",
        prompt: "retain the completed run",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
      });

      const detail = yield* schedules.getDetail(ScheduleId.make("completed-edit"));
      assert.strictEqual(detail.name, "After completion");
      assert.strictEqual(detail.prompt, "retain the completed run");
      assert.strictEqual(detail.state, "completed");
      assert.isNull(detail.nextOccurrenceAt);
    }),
  );

  it.effect("edits passed paused and failed one-time Schedules without changing their state", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      yield* seedProject;

      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-passed-paused-edit"),
        scheduleId: ScheduleId.make("passed-paused-edit"),
        projectId,
        name: "Passed paused",
        prompt: "do not run",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-failed-edit"),
        scheduleId: ScheduleId.make("failed-edit"),
        projectId,
        name: "Failed once",
        prompt: "fail once",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution: { ...execution, workspaceMode: "worktree", baseBranch: "missing" },
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(10));
      yield* schedules.drainDue;

      for (const [id, expectedState] of [
        ["passed-paused-edit", "paused"],
        ["failed-edit", "failed"],
      ] as const) {
        const current = yield* schedules.getDetail(ScheduleId.make(id));
        yield* schedules.dispatch({
          type: "schedule.update",
          commandId: CommandId.make(`edit-${id}`),
          scheduleId: ScheduleId.make(id),
          projectId,
          name: `${current.name} edited`,
          prompt: current.prompt,
          timing: current.timing,
          timeZone: current.timeZone,
          execution: current.execution,
        });
        const edited = yield* schedules.getDetail(ScheduleId.make(id));
        assert.strictEqual(edited.state, expectedState);
        assert.isNull(edited.nextOccurrenceAt);
      }
    }),
  );

  it.effect("rejects a stale pause after a one-time Schedule reaches a terminal state", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      yield* seedProject;

      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-terminal-pause"),
        scheduleId: ScheduleId.make("terminal-pause"),
        projectId,
        name: "Terminal pause",
        prompt: "complete first",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      const error = yield* schedules
        .dispatch({
          type: "schedule.pause",
          commandId: CommandId.make("stale-terminal-pause"),
          scheduleId: ScheduleId.make("terminal-pause"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.failure, "invalid_state");
      assert.strictEqual(
        (yield* schedules.getDetail(ScheduleId.make("terminal-pause"))).state,
        "completed",
      );
    }),
  );

  it.effect("runScheduler recovers a durable due time and wakes on TestClock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const schedules = yield* ScheduleService;
        const launches = yield* RecordedLaunches;
        yield* seedProject;
        yield* schedules.dispatch({
          type: "schedule.create",
          commandId: CommandId.make("create-reactor-restart"),
          scheduleId: ScheduleId.make("reactor-restart"),
          projectId,
          name: "Reactor restart",
          prompt: "launch-after-restart",
          timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
          timeZone: "UTC",
          execution,
          state: "enabled",
        });

        const updates = yield* schedules.subscribe;
        const outcomeReceipt = yield* Stream.drop(updates, 2).pipe(
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const restartedReactor = yield* Effect.forkChild(schedules.runScheduler, {
          startImmediately: true,
        });
        yield* TestClock.adjust(Duration.minutes(5));
        yield* Fiber.join(outcomeReceipt);

        assert.strictEqual((yield* launches.read).length, 1);
        yield* Fiber.interrupt(restartedReactor);
      }),
    ),
  );

  it.effect("derives cache revision from the projection row without snapshotting it", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const revisionScheduleId = ScheduleId.make("projection-revision");
      const created = yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-projection-revision"),
        scheduleId: revisionScheduleId,
        projectId,
        name: "Projection revision",
        prompt: "keep revision out of events",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      assert.strictEqual(
        (yield* schedules.getDetail(revisionScheduleId)).revision,
        created.sequence,
      );
      const paused = yield* schedules.dispatch({
        type: "schedule.pause",
        commandId: CommandId.make("pause-projection-revision"),
        scheduleId: revisionScheduleId,
      });
      assert.strictEqual(
        (yield* schedules.getDetail(revisionScheduleId)).revision,
        paused.sequence,
      );
      const stored = yield* sql<{ readonly recordJson: string }>`
        SELECT record_json AS "recordJson" FROM schedule_definitions
        WHERE schedule_id = ${revisionScheduleId}
      `;
      assert.notInclude(stored[0]?.recordJson ?? "", '"revision"');
    }),
  );

  it.effect(
    "retains each Schedule's newest missed tick and launches retained work oldest first",
    () =>
      Effect.gen(function* () {
        const schedules = yield* ScheduleService;
        const launches = yield* RecordedLaunches;
        yield* seedProject;

        yield* schedules.dispatch({
          type: "schedule.create",
          commandId: CommandId.make("create-later-retained"),
          scheduleId: ScheduleId.make("later-retained"),
          projectId,
          name: "Later retained",
          prompt: "later-retained",
          timing: { type: "cron", expression: "*/5 * * * *" },
          timeZone: "UTC",
          execution,
          state: "enabled",
        });
        yield* schedules.dispatch({
          type: "schedule.create",
          commandId: CommandId.make("create-earlier-retained"),
          scheduleId: ScheduleId.make("earlier-retained"),
          projectId,
          name: "Earlier retained",
          prompt: "earlier-retained",
          timing: { type: "cron", expression: "3/5 * * * *" },
          timeZone: "UTC",
          execution,
          state: "enabled",
        });

        yield* TestClock.adjust(Duration.minutes(22));
        yield* schedules.drainDue;

        const recorded = yield* launches.read;
        assert.deepStrictEqual(
          recorded.map(({ message }) => message.text),
          ["earlier-retained", "later-retained"],
        );
        const earlier = yield* schedules.getDetail(ScheduleId.make("earlier-retained"));
        assert.strictEqual(earlier.history[0]?.type, "skipped");
        if (earlier.history[0]?.type !== "skipped") {
          return yield* Effect.die("Expected compact skipped history.");
        }
        assert.deepStrictEqual(earlier.history[0], {
          type: "skipped",
          count: 3,
          countIsLowerBound: false,
          firstScheduledFor: "1970-01-01T00:03:00.000Z",
          lastScheduledFor: "1970-01-01T00:13:00.000Z",
          recordedAt: "1970-01-01T00:22:00.000Z",
        });
        assert.strictEqual(earlier.history[1]?.type, "triggered");
        const triggered = earlier.history[1];
        if (triggered?.type !== "triggered") {
          return yield* Effect.die("Expected the retained Occurrence to Trigger.");
        }
        assert.strictEqual(triggered.scheduledFor, "1970-01-01T00:18:00.000Z");
      }),
  );

  it.effect("triggers a bounded due page before reserving every overdue Occurrence", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      yield* seedProject;
      const names = Array.from(
        { length: 124 },
        (_, index) => `batch-${index.toString().padStart(2, "0")}`,
      );
      for (const [index, name] of names.entries()) {
        yield* schedules.dispatch({
          type: "schedule.create",
          commandId: CommandId.make(`create-${name}`),
          scheduleId: ScheduleId.make(name),
          projectId,
          name,
          prompt: name,
          timing: {
            type: "one-time",
            runAt: DateTime.formatIso(DateTime.makeUnsafe((index + 1) * 1_000)),
          },
          timeZone: "UTC",
          execution,
          state: "enabled",
        });
      }

      const gate = yield* launches.blockNext;
      yield* TestClock.adjust(Duration.minutes(5));
      const drain = yield* schedules.drainDue.pipe(Effect.forkChild({ startImmediately: true }));
      yield* gate.recorded;

      const atFirstTrigger = yield* schedules.getSnapshot();
      assert.strictEqual(
        atFirstTrigger.schedules.filter(({ nextOccurrenceAt }) => nextOccurrenceAt === null).length,
        100,
      );
      const pauseLast = yield* schedules
        .dispatch({
          type: "schedule.pause",
          commandId: CommandId.make("pause-last-batch-schedule"),
          scheduleId: ScheduleId.make(names.at(-1) as string),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* gate.release;
      yield* Fiber.join(pauseLast);
      assert.isAtMost((yield* launches.read).length, 100);
      yield* Fiber.join(drain);

      assert.deepStrictEqual(
        (yield* launches.read).map(({ message }) => message.text),
        names.slice(0, -1),
      );
    }),
  );

  it.effect("fails an invalid saved timing without starving other due Schedules", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      for (const [id, prompt] of [
        ["invalid-saved-timing", "must-not-launch"],
        ["valid-after-invalid", "valid-launch"],
      ] as const) {
        yield* schedules.dispatch({
          type: "schedule.create",
          commandId: CommandId.make(`create-${id}`),
          scheduleId: ScheduleId.make(id),
          projectId,
          name: id,
          prompt,
          timing: { type: "cron", expression: "*/5 * * * *" },
          timeZone: "UTC",
          execution,
          state: "enabled",
        });
      }
      yield* sql`
        UPDATE schedule_definitions
        SET record_json = json_set(
          record_json,
          '$.timing.expression', 'not a cron expression',
          '$.nextOccurrenceAt', '1970-01-01T00:05:00.000Z'
        ), next_occurrence_at = '1970-01-01T00:05:00.000Z'
        WHERE schedule_id = 'invalid-saved-timing'
      `;

      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      assert.deepStrictEqual(
        (yield* launches.read).map(({ message }) => message.text),
        ["valid-launch"],
      );
      const invalid = yield* schedules.getDetail(ScheduleId.make("invalid-saved-timing"));
      assert.strictEqual(invalid.state, "failed");
      assert.isNull(invalid.nextOccurrenceAt);
      assert.strictEqual(
        invalid.latestHistory?.type === "failed" ? invalid.latestHistory.code : null,
        "invalid_timing",
      );
    }),
  );

  it.effect("pause neutralizes an already-pending scheduled Occurrence", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const pausedScheduleId = ScheduleId.make("pause-pending");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-pause-pending"),
        scheduleId: pausedScheduleId,
        projectId,
        name: "Pause pending",
        prompt: "must-not-launch",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      const occurrenceId = OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c01");
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        )
        SELECT
          ${occurrenceId}, schedule_id, '1970-01-01T00:05:00.000Z', 'scheduled', 'pending', NULL,
          record_json, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        FROM schedule_definitions WHERE schedule_id = ${pausedScheduleId}
      `;

      yield* schedules.dispatch({
        type: "schedule.pause",
        commandId: CommandId.make("pause-pending-command"),
        scheduleId: pausedScheduleId,
      });
      yield* TestClock.adjust(Duration.minutes(10));
      yield* schedules.drainDue;

      assert.strictEqual((yield* launches.read).length, 0);
      assert.strictEqual((yield* schedules.getDetail(pausedScheduleId)).state, "paused");
    }),
  );

  it.effect("replays a durably claimed triggering Occurrence after restart", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ProjectionThreadRepository;
      yield* seedProject;
      const replayScheduleId = ScheduleId.make("replay-triggering");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-replay-triggering"),
        scheduleId: replayScheduleId,
        projectId,
        name: "Replay triggering",
        prompt: "resume-the-claim",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: { ...execution, workspaceMode: "worktree", baseBranch: "main" },
        state: "paused",
      });
      const occurrenceId = OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c03");
      const recoveredThreadId = ThreadId.make(`schedule:${occurrenceId}`);
      yield* threads.upsert({
        threadId: recoveredThreadId,
        projectId,
        title: "Recovered Schedule Thread",
        modelSelection: execution.modelSelection,
        runtimeMode: execution.runtimeMode,
        interactionMode: execution.interactionMode,
        branch: "phoenix/schedule/recovered",
        worktreePath: "/tmp/schedule-project-recovered",
        spawnedByThreadId: null,
        reportDelivery: null,
        latestTurnId: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        )
        SELECT
          ${occurrenceId}, schedule_id, '1970-01-01T00:00:00.000Z', 'manual', 'triggering',
          ${`schedule:${occurrenceId}`}, record_json,
          '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        FROM schedule_definitions WHERE schedule_id = ${replayScheduleId}
      `;

      yield* schedules.drainDue;

      const recorded = yield* launches.read;
      assert.strictEqual(recorded.length, 1);
      assert.isUndefined(recorded[0]?.bootstrap?.createThread);
      assert.isUndefined(recorded[0]?.bootstrap?.prepareWorktree);
      assert.strictEqual(
        recorded[0]?.bootstrap?.recoverExistingThread?.worktreePath,
        "/tmp/schedule-project-recovered",
      );
      const detail = yield* schedules.getDetail(replayScheduleId);
      assert.strictEqual(detail.state, "paused");
      assert.strictEqual(detail.latestHistory?.type, "triggered");
      assert.strictEqual(
        detail.latestHistory?.type === "triggered" ? detail.latestHistory.occurrenceId : null,
        occurrenceId,
      );
    }),
  );

  it.effect("cleans a recovered Thread before recording an unavailable prerequisite", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const providers = yield* ProviderSnapshots;
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ProjectionThreadRepository;
      yield* seedProject;
      const recoveredScheduleId = ScheduleId.make("recovered-disabled-provider");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-recovered-disabled-provider"),
        scheduleId: recoveredScheduleId,
        projectId,
        name: "Recovered disabled provider",
        prompt: "must-clean-before-failing",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      const occurrenceId = OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c04");
      const recoveredThreadId = ThreadId.make(`schedule:${occurrenceId}`);
      yield* threads.upsert({
        threadId: recoveredThreadId,
        projectId,
        title: "Interrupted Schedule Thread",
        modelSelection: execution.modelSelection,
        runtimeMode: execution.runtimeMode,
        interactionMode: execution.interactionMode,
        branch: null,
        worktreePath: null,
        spawnedByThreadId: null,
        reportDelivery: null,
        latestTurnId: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        ) SELECT ${occurrenceId}, schedule_id, '1970-01-01T00:00:00.000Z', 'manual',
          'triggering', ${recoveredThreadId}, record_json,
          '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        FROM schedule_definitions WHERE schedule_id = ${recoveredScheduleId}
      `;
      yield* providers.set([{ ...availableProvider, enabled: false, status: "disabled" }]);

      yield* schedules.drainDue;

      assert.deepStrictEqual(yield* launches.readCleanups, [recoveredThreadId]);
      assert.strictEqual((yield* launches.read).length, 0);
      const detail = yield* schedules.getDetail(recoveredScheduleId);
      assert.strictEqual(
        detail.latestHistory?.type === "failed" ? detail.latestHistory.code : null,
        "provider_unavailable",
      );
    }),
  );

  it.effect("records Triggered when recovery finds the deterministic first Turn accepted", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const providers = yield* ProviderSnapshots;
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ProjectionThreadRepository;
      yield* seedProject;
      const acceptedScheduleId = ScheduleId.make("recovered-accepted-turn");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-recovered-accepted-turn"),
        scheduleId: acceptedScheduleId,
        projectId,
        name: "Recovered accepted turn",
        prompt: "already accepted",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      const occurrenceId = OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c07");
      const recoveredThreadId = ThreadId.make(`schedule:${occurrenceId}`);
      yield* threads.upsert({
        threadId: recoveredThreadId,
        projectId,
        title: "Accepted Schedule Thread",
        modelSelection: execution.modelSelection,
        runtimeMode: execution.runtimeMode,
        interactionMode: execution.interactionMode,
        branch: null,
        worktreePath: null,
        spawnedByThreadId: null,
        reportDelivery: null,
        latestTurnId: TurnId.make("schedule-first-turn"),
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          ${recoveredThreadId}, ${TurnId.make("schedule-first-turn")}, 'running',
          '1970-01-01T00:00:00.000Z', '[]'
        )
      `;
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        ) SELECT ${occurrenceId}, schedule_id, '1970-01-01T00:00:00.000Z', 'manual',
          'triggering', ${recoveredThreadId}, record_json,
          '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        FROM schedule_definitions WHERE schedule_id = ${acceptedScheduleId}
      `;
      yield* providers.set([{ ...availableProvider, enabled: false, status: "disabled" }]);

      yield* schedules.drainDue;

      assert.deepStrictEqual(yield* launches.readCleanups, []);
      assert.strictEqual((yield* launches.read).length, 0);
      const detail = yield* schedules.getDetail(acceptedScheduleId);
      assert.strictEqual(detail.latestHistory?.type, "triggered");
      assert.strictEqual(
        detail.latestHistory?.type === "triggered" ? detail.latestHistory.threadId : null,
        recoveredThreadId,
      );
    }),
  );

  it.effect("deduplicates Run now by durable command and Occurrence identities", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      yield* seedProject;
      const runNowScheduleId = ScheduleId.make("run-now-idempotent");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-run-now-idempotent"),
        scheduleId: runNowScheduleId,
        projectId,
        name: "Run now",
        prompt: "run-once",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      const command = {
        type: "schedule.run-now" as const,
        commandId: CommandId.make("same-run-now-command"),
        scheduleId: runNowScheduleId,
        occurrenceId: OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c02"),
      };
      yield* schedules.dispatch(command);
      yield* schedules.dispatch(command);
      const conflict = yield* schedules
        .dispatch({
          ...command,
          occurrenceId: OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c0a"),
        })
        .pipe(Effect.flip);

      assert.strictEqual((yield* launches.read).length, 1);
      assert.strictEqual(conflict.failure, "command_conflict");
      const detail = yield* schedules.getDetail(runNowScheduleId);
      assert.strictEqual(detail.state, "paused");
      assert.strictEqual(detail.history.length, 1);
    }),
  );

  it.effect("replays a reserved Run now receipt after a crash before Trigger", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const replayScheduleId = ScheduleId.make("run-now-receipt-recovery");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-run-now-receipt-recovery"),
        scheduleId: replayScheduleId,
        projectId,
        name: "Run now receipt recovery",
        prompt: "recover pending run",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      const command = {
        type: "schedule.run-now" as const,
        commandId: CommandId.make("reserved-run-now-receipt"),
        scheduleId: replayScheduleId,
        occurrenceId: OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c0b"),
      };
      const commandJson = yield* encodeScheduleCommandJson(command);
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        ) SELECT ${command.occurrenceId}, schedule_id, '1970-01-01T00:00:00.000Z',
          'manual', 'pending', NULL, record_json,
          '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
        FROM schedule_definitions WHERE schedule_id = ${replayScheduleId}
      `;
      yield* sql`
        INSERT INTO schedule_commands (
          command_id, schedule_id, result_sequence, accepted_at, command_json
        ) VALUES (
          ${command.commandId}, ${replayScheduleId}, 999,
          '1970-01-01T00:00:00.000Z', ${commandJson}
        )
      `;

      const replayed = yield* schedules.dispatch(command);

      assert.strictEqual(replayed.sequence, 999);
      assert.strictEqual((yield* launches.read).length, 1);
      assert.strictEqual(
        (yield* schedules.getDetail(replayScheduleId)).latestHistory?.type,
        "triggered",
      );
    }),
  );

  it.effect("bounds detail history and pages every older entry without rewriting definitions", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const historyScheduleId = ScheduleId.make("paged-history");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-paged-history"),
        scheduleId: historyScheduleId,
        projectId,
        name: "Paged history",
        prompt: "record-this-run",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });

      for (let index = 0; index < 55; index += 1) {
        yield* schedules.dispatch({
          type: "schedule.run-now",
          commandId: CommandId.make(`paged-history-command-${index}`),
          scheduleId: historyScheduleId,
          occurrenceId: OccurrenceId.make(index.toString(16).padStart(32, "0")),
        });
      }

      const detail = yield* schedules.getDetail(historyScheduleId);
      assert.strictEqual(detail.history.length, 50);
      assert.isNotNull(detail.historyNextCursor);
      const older = yield* schedules.getHistory({
        scheduleId: historyScheduleId,
        ...(detail.historyNextCursor === null ? {} : { cursor: detail.historyNextCursor }),
        limit: 50,
      });
      assert.strictEqual(older.entries.length, 5);
      assert.isNull(older.nextCursor);
      assert.strictEqual(detail.history.length + older.entries.length, 55);

      const stored = yield* sql<{ readonly recordJson: string }>`
        SELECT record_json AS "recordJson"
        FROM schedule_definitions WHERE schedule_id = ${historyScheduleId}
      `;
      assert.notInclude(stored[0]?.recordJson ?? "", '"history"');
      assert.strictEqual(
        (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM schedule_history
            WHERE schedule_id = ${historyScheduleId}
          `)[0]?.count,
        55,
      );
      const occurrenceEvents = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM schedule_events
        WHERE schedule_id = ${historyScheduleId}
          AND event_type LIKE 'schedule.occurrence-%'
      `;
      assert.isTrue(occurrenceEvents.every(({ payloadJson }) => !payloadJson.includes('"prompt"')));
    }),
  );

  it.effect("replays an accepted command receipt after its Schedule was deleted", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      yield* seedProject;
      const deletedScheduleId = ScheduleId.make("deleted-receipt-replay");
      const createCommand = {
        type: "schedule.create" as const,
        commandId: CommandId.make("create-deleted-receipt-replay"),
        scheduleId: deletedScheduleId,
        projectId,
        name: "Deleted receipt replay",
        prompt: "only create once",
        timing: { type: "cron" as const, expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused" as const,
      };
      const accepted = yield* schedules.dispatch(createCommand);
      yield* schedules.dispatch({
        type: "schedule.delete",
        commandId: CommandId.make("delete-deleted-receipt-replay"),
        scheduleId: deletedScheduleId,
      });

      const replayed = yield* schedules.dispatch(createCommand);
      assert.deepStrictEqual(replayed, accepted);
      assert.strictEqual(
        (yield* schedules.getDetail(deletedScheduleId).pipe(Effect.flip)).failure,
        "not_found",
      );
    }),
  );

  it.effect("rebuilds the durable definition by replaying persisted typed events", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject;
      const replayedScheduleId = ScheduleId.make("domain-event-replay");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-domain-event-replay"),
        scheduleId: replayedScheduleId,
        projectId,
        name: "Domain replay",
        prompt: "Rebuild me from events",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* schedules.dispatch({
        type: "schedule.pause",
        commandId: CommandId.make("pause-domain-event-replay"),
        scheduleId: replayedScheduleId,
      });
      yield* schedules.dispatch({
        type: "schedule.run-now",
        commandId: CommandId.make("run-domain-event-replay"),
        scheduleId: replayedScheduleId,
        occurrenceId: OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c09"),
      });

      const rows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM schedule_events
        WHERE schedule_id = ${replayedScheduleId} ORDER BY sequence ASC
      `;
      const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduleDomainEvent));
      const events = yield* Effect.forEach(rows, ({ payloadJson }) => decodeEvent(payloadJson));
      const rebuilt = events.reduce(evolveScheduleDefinition, null);
      const detail = yield* schedules.getDetail(replayedScheduleId);
      assert.strictEqual(rebuilt?.id, detail.id);
      assert.strictEqual(rebuilt?.state, "paused");
      assert.strictEqual(rebuilt?.nextOccurrenceAt, null);
      assert.strictEqual(rebuilt?.prompt, detail.prompt);
      assert.deepStrictEqual(rebuilt?.latestHistory, detail.latestHistory);
    }),
  );

  it.effect("fails before bootstrap when the saved provider or model is unavailable", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      const providers = yield* ProviderSnapshots;
      yield* seedProject;

      yield* providers.set([{ ...availableProvider, enabled: false, status: "disabled" }]);
      const disabledProviderSchedule = ScheduleId.make("disabled-provider");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-disabled-provider"),
        scheduleId: disabledProviderSchedule,
        projectId,
        name: "Disabled provider",
        prompt: "must-not-bootstrap-provider",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;
      const providerFailure = yield* schedules.getDetail(disabledProviderSchedule);
      assert.strictEqual(providerFailure.state, "failed");
      assert.strictEqual(
        providerFailure.latestHistory?.type === "failed"
          ? providerFailure.latestHistory.code
          : null,
        "provider_unavailable",
      );

      yield* providers.set([{ ...availableProvider, models: [] }]);
      const missingModelSchedule = ScheduleId.make("missing-model");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-missing-model"),
        scheduleId: missingModelSchedule,
        projectId,
        name: "Missing model",
        prompt: "must-not-bootstrap-model",
        timing: { type: "one-time", runAt: "1970-01-01T00:10:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;
      const modelFailure = yield* schedules.getDetail(missingModelSchedule);
      assert.strictEqual(modelFailure.state, "failed");
      assert.strictEqual(
        modelFailure.latestHistory?.type === "failed" ? modelFailure.latestHistory.code : null,
        "model_unavailable",
      );
      assert.strictEqual((yield* launches.read).length, 0);
    }),
  );

  it.effect("fails visibly when the target Project is deleted before the due time", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      yield* seedProject;
      const deletedProjectSchedule = ScheduleId.make("deleted-project");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-deleted-project"),
        scheduleId: deletedProjectSchedule,
        projectId,
        name: "Deleted project",
        prompt: "must-not-bootstrap-project",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      });
      yield* projects.deleteById({ projectId });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      const detail = yield* schedules.getDetail(deletedProjectSchedule);
      assert.strictEqual(detail.state, "failed");
      assert.strictEqual(
        detail.latestHistory?.type === "failed" ? detail.latestHistory.code : null,
        "project_not_found",
      );
      assert.strictEqual((yield* launches.read).length, 0);
    }),
  );

  it.effect("records an invalid worktree base as a pre-Trigger bootstrap failure", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const launches = yield* RecordedLaunches;
      yield* seedProject;
      const invalidBaseSchedule = ScheduleId.make("invalid-worktree-base");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-invalid-worktree-base"),
        scheduleId: invalidBaseSchedule,
        projectId,
        name: "Invalid worktree base",
        prompt: "must-not-bootstrap-base",
        timing: { type: "one-time", runAt: "1970-01-01T00:05:00.000Z" },
        timeZone: "UTC",
        execution: { ...execution, workspaceMode: "worktree", baseBranch: "missing" },
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;

      const detail = yield* schedules.getDetail(invalidBaseSchedule);
      assert.strictEqual(detail.state, "failed");
      assert.strictEqual(
        detail.latestHistory?.type === "failed" ? detail.latestHistory.code : null,
        "thread_bootstrap_rejected",
      );

      const recurringSchedule = ScheduleId.make("invalid-worktree-base-recurring");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-invalid-worktree-base-recurring"),
        scheduleId: recurringSchedule,
        projectId,
        name: "Invalid recurring worktree base",
        prompt: "retry-on-next-tick",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: { ...execution, workspaceMode: "worktree", baseBranch: "missing" },
        state: "enabled",
      });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* schedules.drainDue;
      const recurring = yield* schedules.getDetail(recurringSchedule);
      assert.strictEqual(recurring.state, "enabled");
      assert.strictEqual(recurring.nextOccurrenceAt, "1970-01-01T00:15:00.000Z");
      assert.strictEqual(
        recurring.latestHistory?.type === "failed" ? recurring.latestHistory.code : null,
        "thread_bootstrap_rejected",
      );
      assert.strictEqual((yield* launches.read).length, 0);
    }),
  );

  it.effect("compacts consecutive identical failures without losing their count", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      yield* seedProject;
      const compactedScheduleId = ScheduleId.make("compacted-failures");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-compacted-failures"),
        scheduleId: compactedScheduleId,
        projectId,
        name: "Compacted failures",
        prompt: "fail identically",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: { ...execution, workspaceMode: "worktree", baseBranch: "missing" },
        state: "paused",
      });
      for (const [suffix, occurrenceId] of [
        ["one", "018fd1b2-6610-7e39-8f09-468fa24c8c05"],
        ["two", "018fd1b2-6610-7e39-8f09-468fa24c8c06"],
      ] as const) {
        yield* schedules.dispatch({
          type: "schedule.run-now",
          commandId: CommandId.make(`run-compacted-failure-${suffix}`),
          scheduleId: compactedScheduleId,
          occurrenceId: OccurrenceId.make(occurrenceId),
        });
      }

      const detail = yield* schedules.getDetail(compactedScheduleId);
      assert.strictEqual(detail.history.length, 1);
      assert.strictEqual(detail.latestHistory?.type, "failed");
      assert.strictEqual(
        detail.latestHistory?.type === "failed" ? detail.latestHistory.count : 0,
        2,
      );
    }),
  );

  it.effect("rejects non-Git worktree definitions and accepts local Git without a remote", () =>
    Effect.gen(function* () {
      const schedules = yield* ScheduleService;
      const projects = yield* ProjectionProjectRepository;
      yield* seedProject;
      const setWorkspace = (workspaceRoot: string) =>
        projects.upsert({
          projectId,
          title: "Schedule project",
          workspaceRoot,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          scripts: [],
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
          deletedAt: null,
        });
      const worktreeExecution = {
        ...execution,
        workspaceMode: "worktree" as const,
        baseBranch: "main",
      };

      yield* setWorkspace("/tmp/not-git");
      const createError = yield* schedules
        .dispatch({
          type: "schedule.create",
          commandId: CommandId.make("create-non-git-worktree"),
          scheduleId: ScheduleId.make("non-git-worktree"),
          projectId,
          name: "Non Git worktree",
          prompt: "must reject",
          timing: { type: "cron", expression: "*/5 * * * *" },
          timeZone: "UTC",
          execution: worktreeExecution,
          state: "paused",
        })
        .pipe(Effect.flip);
      assert.strictEqual(createError.failure, "invalid_workspace");

      yield* setWorkspace("/tmp/schedule-project");
      const updateScheduleId = ScheduleId.make("update-worktree-validation");
      yield* schedules.dispatch({
        type: "schedule.create",
        commandId: CommandId.make("create-update-worktree-validation"),
        scheduleId: updateScheduleId,
        projectId,
        name: "Update validation",
        prompt: "update me",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "paused",
      });
      const updateCommand = {
        type: "schedule.update" as const,
        commandId: CommandId.make("update-to-worktree"),
        scheduleId: updateScheduleId,
        projectId,
        name: "Update validation",
        prompt: "update me",
        timing: { type: "cron" as const, expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: worktreeExecution,
      };
      yield* setWorkspace("/tmp/not-git");
      assert.strictEqual(
        (yield* schedules.dispatch(updateCommand).pipe(Effect.flip)).failure,
        "invalid_workspace",
      );

      yield* setWorkspace("/tmp/schedule-project");
      yield* schedules.dispatch({
        ...updateCommand,
        commandId: CommandId.make("update-to-local-git-worktree"),
      });
      assert.strictEqual(
        (yield* schedules.getDetail(updateScheduleId)).execution.workspaceMode,
        "worktree",
      );
    }),
  );
});
