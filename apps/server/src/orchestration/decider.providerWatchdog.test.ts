import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const CRASHED_TURN_ID = TurnId.make("turn-crashed");

const makeSession = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: THREAD_ID,
  status: "running",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: CRASHED_TURN_ID,
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});

const makeReadModel = (session: OrchestrationSession | null): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
      session,
      queuedTurnStarts: [],
    },
  ],
  updatedAt: NOW,
});

// The verdict the provider-inactivity watchdog dispatches once it has decided
// a runtime died mid-turn.
const crashCommand = (onlyIfActiveTurnId = CRASHED_TURN_ID) =>
  ({
    type: "thread.session.set",
    commandId: CommandId.make("cmd-provider-watchdog"),
    threadId: THREAD_ID,
    session: makeSession({
      status: "error",
      activeTurnId: null,
      lastError: "Provider session stopped responding.",
      stoppedBy: "system",
      stopReason: "provider_crashed",
      updatedAt: NOW,
    }),
    onlyIfActiveTurnId,
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("thread.session.set provider-crash guard", (it) => {
  it.effect("applies the crash verdict while the thread still runs that turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: crashCommand(),
        readModel: makeReadModel(makeSession()),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      const event = events[0]!;
      if (event.type !== "thread.session-set") throw new Error("expected a session-set event");
      expect(event.payload.session.status).toBe("error");
      expect(event.payload.session.activeTurnId).toBeNull();
      expect(event.payload.session.stoppedBy).toBe("system");
      expect(event.payload.session.stopReason).toBe("provider_crashed");
    }),
  );

  it.effect("rejects the crash verdict once the provider started a different turn", () =>
    Effect.gen(function* () {
      // The heartbeat case: the runtime was alive after all and opened a new
      // turn between the watchdog's snapshot read and this command.
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: crashCommand(),
          readModel: makeReadModel(makeSession({ activeTurnId: TurnId.make("turn-fresh") })),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects the crash verdict once the turn completed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: crashCommand(),
          readModel: makeReadModel(makeSession({ status: "ready", activeTurnId: null })),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects the crash verdict once a real provider terminal event landed", () =>
    Effect.gen(function* () {
      // A genuine session exit is fresher truth than the watchdog's inference,
      // and it must not be rewritten with a second, contradicting verdict.
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: crashCommand(),
          readModel: makeReadModel(
            makeSession({
              status: "stopped",
              activeTurnId: null,
              stoppedBy: "user",
              stopReason: "user_stopped",
            }),
          ),
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("leaves unconditional session writes untouched", () =>
    Effect.gen(function* () {
      const { onlyIfActiveTurnId: _guard, ...unconditional } = crashCommand();
      const decided = yield* decideOrchestrationCommand({
        command: unconditional,
        readModel: makeReadModel(makeSession({ status: "ready", activeTurnId: null })),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );
});
