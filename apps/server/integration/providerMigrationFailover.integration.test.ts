/**
 * The migration path with `ProviderCommandReactor`, `ProviderService` and
 * `ProviderSessionDirectory` wired together.
 *
 * `ProviderCommandReactor.test.ts` stubs `startSession`, so it cannot see the
 * guard inside `ProviderService` that a sanctioned migration has to cross. That
 * gap is why a thread once auto-failed over and then could never start again:
 * the reactor asked for the switch, `startSession` refused it using the very
 * binding the switch was replacing, and no unit test covered the pair.
 *
 * @module integration/providerMigrationFailover
 */
import {
  CommandId,
  EventId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const ORIGIN_INSTANCE = defaultInstanceIdForDriver(PROVIDER);
const TARGET_INSTANCE = ProviderInstanceId.make("codex_failover");
const PROJECT_ID = ProjectId.make("11111111-1111-4111-8111-111111111111");
const THREAD_ID = ThreadId.make("22222222-2222-4222-8222-222222222222");
const MODEL = "gpt-5-codex";
const CREATED_AT = "2026-02-24T10:00:00.000Z";
const MIGRATED_AT = "2026-02-24T10:05:00.000Z";
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const TURN_ID = ThreadId.make("33333333-3333-4333-8333-333333333333");
const RETRY_TURN_ID = ThreadId.make("44444444-4444-4444-8444-444444444444");

/** Let the origin turn finish cleanly, so the only error the assertions can
 * see afterwards is the migration being refused. */
const originTurnResponse = {
  events: [
    {
      type: "turn.started" as const,
      eventId: asEventId("evt-origin-1"),
      provider: PROVIDER,
      createdAt: CREATED_AT,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    },
    {
      type: "turn.completed" as const,
      eventId: asEventId("evt-origin-2"),
      provider: PROVIDER,
      createdAt: CREATED_AT,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      status: "completed" as const,
    },
  ],
};

/** Auto-failover retries the failed turn on the target, so that adapter needs a
 * response too — otherwise its "no queued response" error lands on the session
 * and looks like a failed migration. */
const targetRetryResponse = {
  events: [
    {
      type: "turn.started" as const,
      eventId: asEventId("evt-target-1"),
      provider: PROVIDER,
      createdAt: MIGRATED_AT,
      threadId: THREAD_ID,
      turnId: RETRY_TURN_ID,
    },
    {
      type: "turn.completed" as const,
      eventId: asEventId("evt-target-2"),
      provider: PROVIDER,
      createdAt: MIGRATED_AT,
      threadId: THREAD_ID,
      turnId: RETRY_TURN_ID,
      status: "completed" as const,
    },
  ],
};

const withHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({
      provider: PROVIDER,
      additionalInstanceIds: [TARGET_INSTANCE],
    }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));

describe("provider migration across accounts", () => {
  it.live(
    "an auto-failover migration starts a session on the target account",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const createdAt = CREATED_AT;

          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-project"),
            projectId: PROJECT_ID,
            title: "Migration Project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: { instanceId: ORIGIN_INSTANCE, model: MODEL },
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread"),
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Migration Thread",
            modelSelection: { instanceId: ORIGIN_INSTANCE, model: MODEL },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: harness.workspaceDir,
            createdAt,
          });

          // Start on the origin account so the directory holds a real binding
          // with a resume cursor — the state the guard refuses to cross.
          yield* harness.adapterHarness!.queueTurnResponseForNextSession(originTurnResponse);
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-turn-origin"),
            threadId: THREAD_ID,
            message: {
              messageId: asMessageId("message-origin"),
              role: "user",
              text: "work on the origin account",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          });
          // Wait on the turn's own completion receipt, not a projection poll:
          // the instance id is already set while the turn is still running, and
          // dispatching the migration then trips requireThreadTurnNotRunning
          // before the guard under test is ever reached.
          yield* harness.waitForReceipt(
            (receipt) =>
              receipt.type === "provider.turn.completed" && receipt.threadId === THREAD_ID,
          );
          yield* harness.drainProviderRuntime;
          const origin = yield* harness.waitForThread(
            String(THREAD_ID),
            (thread) => thread.session?.providerInstanceId === ORIGIN_INSTANCE,
          );
          expect(origin.session?.providerInstanceId).toBe(ORIGIN_INSTANCE);

          const targetHarness = harness.adapterHarnessByInstanceId.get(TARGET_INSTANCE);
          expect(targetHarness).toBeDefined();
          yield* targetHarness!.queueTurnResponseForNextSession(targetRetryResponse);

          // The failover itself. Without the reactor authorising the switch,
          // startSession rejects it as an incompatible resume state and the
          // thread stays on the origin account — wedged.
          yield* harness.engine.dispatch({
            type: "thread.migrate",
            commandId: CommandId.make("cmd-migrate"),
            threadId: THREAD_ID,
            targetInstanceId: TARGET_INSTANCE,
            targetModel: MODEL,
            handoffMode: "replay",
            trigger: "auto-failover",
            createdAt: MIGRATED_AT,
          });

          // Also settles on a recorded error, and bounded well under the
          // default: a refused migration is only logged — nothing marks the
          // session — so without a bound this waits out the full timeout to say
          // nothing useful. The success path settles in well under a second.
          const migrated = yield* harness.waitForThread(
            String(THREAD_ID),
            (thread) =>
              thread.session?.providerInstanceId === TARGET_INSTANCE ||
              (thread.session?.lastError ?? null) !== null,
            15_000,
          );

          expect(migrated.session?.lastError ?? null).toBeNull();
          expect(migrated.session?.providerInstanceId).toBe(TARGET_INSTANCE);
          expect(migrated.modelSelection.instanceId).toBe(TARGET_INSTANCE);
        }),
      ),
    60_000,
  );
});
