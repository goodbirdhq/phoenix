import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  THREAD_MIGRATION_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-08-19T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const ORIGIN = ProviderInstanceId.make("claude_personal");
const TARGET = ProviderInstanceId.make("claude_work");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ORIGIN,
          model: "claude-opus-5",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        reports: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

function migrateCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "thread.migrate",
    commandId: CommandId.make("cmd-migrate"),
    threadId: THREAD_ID,
    targetInstanceId: TARGET,
    handoffMode: "replay",
    trigger: "manual",
    createdAt: NOW,
    ...overrides,
  } as const as Parameters<typeof decideOrchestrationCommand>[0]["command"];
}

it.layer(NodeServices.layer)("thread migration decider", (it) => {
  it.effect("rejects a metadata account switch after a thread has started", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stale-composer-account-switch"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: TARGET,
            model: "claude-opus-5",
          },
        },
        readModel: makeReadModel({
          latestTurn: {
            turnId: TurnId.make("turn-limited"),
            state: "error",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        }),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("thread.migrate");
      }
    }),
  );

  it.effect("allows choosing an account through metadata before the first turn", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-draft-account-selection"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: TARGET,
            model: "claude-opus-5",
          },
        },
        readModel: makeReadModel(),
      });

      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: { modelSelection: { instanceId: TARGET } },
      });
    }),
  );

  it.effect("allows a started thread to change models within its current instance", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-same-account-model-selection"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: ORIGIN,
            model: "claude-fable-5",
          },
        },
        readModel: makeReadModel({
          latestTurn: {
            turnId: TurnId.make("turn-completed"),
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        }),
      });

      expect(event).toMatchObject({
        type: "thread.meta-updated",
        payload: {
          modelSelection: { instanceId: ORIGIN, model: "claude-fable-5" },
        },
      });
    }),
  );

  it.effect("rebinds the thread to the target instance and records the move", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: migrateCommand({ brief: "Continue from the completed contract work." }),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.migrated",
        "thread.activity-appended",
      ]);
      const migrated = events[0]!;
      if (migrated.type !== "thread.migrated") throw new Error("expected thread.migrated");
      expect(migrated.payload.fromModelSelection.instanceId).toBe(ORIGIN);
      expect(migrated.payload.modelSelection).toEqual({
        instanceId: TARGET,
        model: "claude-opus-5",
        // Same model slug, so the reasoning-effort selection rides along.
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      expect(migrated.payload.handoffMode).toBe("replay");
      expect(migrated.payload.brief).toBe("Continue from the completed contract work.");
      expect(migrated.payload.trigger).toBe("manual");
    }),
  );

  it.effect("writes a history row naming both accounts", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: migrateCommand({ handoffMode: "brief", trigger: "limit-popup" }),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const appended = events[1]!;
      if (appended.type !== "thread.activity-appended")
        throw new Error("expected thread.activity-appended");

      expect(appended.payload.activity.kind).toBe(THREAD_MIGRATION_ACTIVITY_KIND);
      expect(appended.payload.activity.tone).toBe("info");
      // Derived from the command id so a redelivered migrate upserts one row.
      expect(appended.payload.activity.id).toBe("thread-migration:cmd-migrate");
      expect(appended.payload.activity.summary).toContain("claude_personal");
      expect(appended.payload.activity.summary).toContain("claude_work");
      expect(appended.payload.activity.payload).toEqual({
        fromInstanceId: ORIGIN,
        fromModel: "claude-opus-5",
        toInstanceId: TARGET,
        toModel: "claude-opus-5",
        handoffMode: "brief",
        trigger: "limit-popup",
      });
    }),
  );

  it.effect("drops option selections when the model changes", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: migrateCommand({ targetModel: "gpt-5-codex" }),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const migrated = events[0]!;
      if (migrated.type !== "thread.migrated") throw new Error("expected thread.migrated");

      // Option ids are model-specific; carrying them would apply a setting
      // the user never chose on the new model.
      expect(migrated.payload.modelSelection).toEqual({
        instanceId: TARGET,
        model: "gpt-5-codex",
      });
    }),
  );

  it.effect("refuses to migrate a thread mid-turn", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: migrateCommand(),
          readModel: makeReadModel({
            latestTurn: {
              turnId: TurnId.make("turn-1"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("migrates a thread whose last turn already settled", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: migrateCommand(),
        readModel: makeReadModel({
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "error",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.migrated");
    }),
  );

  it.effect("refuses a migration that would not move the thread", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: migrateCommand({ targetInstanceId: ORIGIN }),
          readModel: makeReadModel(),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses to migrate an archived thread", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: migrateCommand(),
          readModel: makeReadModel({ archivedAt: NOW }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses to migrate a thread that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: migrateCommand({ threadId: ThreadId.make("missing") }),
          readModel: makeReadModel(),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("leaves the read model reading the target instance", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const decided = yield* decideOrchestrationCommand({
        command: migrateCommand({ targetModel: "claude-sonnet-5" }),
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      let projected = readModel;
      let sequence = 0;
      for (const event of events) {
        sequence += 1;
        projected = yield* projectEvent(projected, { ...event, sequence });
      }

      const thread = projected.threads[0]!;
      expect(thread.modelSelection).toEqual({
        instanceId: TARGET,
        model: "claude-sonnet-5",
      });
      expect(thread.activities.map((activity) => activity.kind)).toEqual([
        THREAD_MIGRATION_ACTIVITY_KIND,
      ]);
    }),
  );
});
