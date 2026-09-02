import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  RuntimeItemId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  HANDOFF_BRIEF_PROMPT,
  HandoffBrief,
  HandoffBriefTurnFailedError,
} from "../Services/HandoffBrief.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { HandoffBriefLive } from "./HandoffBrief.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";

const THREAD_ID = ThreadId.make("handoff-thread");
const PROJECT_ID = ProjectId.make("handoff-project");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const TURN_ID = TurnId.make("handoff-turn");
const CREATED_AT = "2026-08-19T12:00:00.000Z";
const BRIEF_TEXT = `# Handoff

Current state, decisions, in-flight work, and next steps are captured here.`;

type ProviderOutcome = "completed" | "rate-limited";

const isHandoffBriefTurnFailedError = Schema.is(HandoffBriefTurnFailedError);

const makeProviderHarness = Effect.fn("makeProviderHarness")(function* (outcome: ProviderOutcome) {
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sentTurns = yield* Ref.make<ReadonlyArray<ProviderSendTurnInput>>([]);
  const session: ProviderSession = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: PROVIDER_INSTANCE_ID,
    status: "ready",
    runtimeMode: "approval-required",
    cwd: "/tmp/handoff-project",
    model: "gpt-5-codex",
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("MockProvider.sendTurn")(
    function* (input) {
      yield* Ref.update(sentTurns, (turns) => [...turns, input]);
      if (outcome === "rate-limited") {
        return yield* new ProviderAdapterRequestError({
          provider: "codex",
          method: "sendTurn",
          detail: "Origin account is rate-limited.",
        });
      }

      const events: ReadonlyArray<ProviderRuntimeEvent> = [
        {
          type: "turn.started",
          eventId: EventId.make("handoff-turn-started"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: PROVIDER_INSTANCE_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: CREATED_AT,
          payload: {},
        },
        {
          type: "item.completed",
          eventId: EventId.make("handoff-message-completed"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: PROVIDER_INSTANCE_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: RuntimeItemId.make("handoff-message"),
          createdAt: CREATED_AT,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: BRIEF_TEXT,
          },
        },
        {
          type: "turn.completed",
          eventId: EventId.make("handoff-turn-completed"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: PROVIDER_INSTANCE_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: CREATED_AT,
          payload: { state: "completed" },
        },
      ];
      yield* Effect.forEach(events, (event) => PubSub.publish(runtimeEvents, event)).pipe(
        Effect.asVoid,
      );
      return { threadId: THREAD_ID, turnId: TURN_ID };
    },
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in handoff brief test")) as Effect.Effect<
      A,
      never
    >;
  const service = ProviderService.of({
    startSession: () => unsupported(),
    sendTurn,
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([session]),
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: "in-session",
        conversationSeeding: "framed-prompt",
      } as const),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: "codex:home:/handoff-test",
        },
      }),
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEvents);
    },
  } satisfies ProviderServiceShape);

  return {
    layer: Layer.succeed(ProviderService, service),
    sentTurns,
  };
});

const makeTestLayer = (providerLayer: Layer.Layer<ProviderService>) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const textGenerationLayer = Layer.mock(TextGeneration, {
    generateBranchName: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in handoff brief test",
        }),
      ),
    generateThreadTitle: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in handoff brief test",
        }),
      ),
  });

  return Layer.empty.pipe(
    Layer.provideMerge(HandoffBriefLive),
    Layer.provideMerge(ProviderRuntimeIngestionLive),
    Layer.provideMerge(ProviderCommandReactorLive),
    Layer.provideMerge(RuntimeReceiptBusLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(makeProviderRegistryLayer([{ instanceId: PROVIDER_INSTANCE_ID }] as never)),
    Layer.provideMerge(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        renameBranch: () => Effect.die("renameBranch should not be called in handoff brief tests"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(VcsStatusBroadcaster, {
        getStatus: () => Effect.die("getStatus should not be called in handoff brief tests"),
        refreshLocalStatus: () =>
          Effect.die("refreshLocalStatus should not be called in handoff brief tests"),
        refreshStatus: () =>
          Effect.die("refreshStatus should not be called in handoff brief tests"),
        streamStatus: () => Stream.die("streamStatus should not be called in handoff brief tests"),
      }),
    ),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
};

const runHandoffCase = Effect.fn("runHandoffCase")(function* (providerOutcome: ProviderOutcome) {
  const provider = yield* makeProviderHarness(providerOutcome);
  return yield* Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const handoffBrief = yield* HandoffBrief;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerCommandReactor = yield* ProviderCommandReactor;
    const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("handoff-project-create"),
      projectId: PROJECT_ID,
      title: "Handoff Project",
      workspaceRoot: "/tmp/handoff-project",
      defaultModelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5-codex",
      },
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("handoff-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Existing migration work",
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("handoff-session-seed"),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "codex",
        providerInstanceId: PROVIDER_INSTANCE_ID,
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: CREATED_AT,
      },
      createdAt: CREATED_AT,
    });

    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();

    const result = yield* Effect.exit(handoffBrief.create(THREAD_ID));
    yield* providerCommandReactor.drain;
    yield* providerRuntimeIngestion.drain;

    return {
      result,
      snapshot: yield* projectionSnapshotQuery.getSnapshot(),
      sentTurns: yield* Ref.get(provider.sentTurns),
    };
  }).pipe(Effect.provide(makeTestLayer(provider.layer)), Effect.scoped);
});

it.effect("returns the final assistant message from the visible handoff turn", () =>
  Effect.gen(function* () {
    const { result, snapshot, sentTurns } = yield* runHandoffCase("completed");

    if (Exit.isFailure(result)) {
      throw Cause.squash(result.cause);
    }
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toBe(BRIEF_TEXT);
    }
    expect(sentTurns).toHaveLength(1);
    expect(sentTurns[0]?.input).toBe(HANDOFF_BRIEF_PROMPT);

    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    expect(
      thread?.messages.some(
        (message) => message.role === "user" && message.text === HANDOFF_BRIEF_PROMPT,
      ),
    ).toBe(true);
    expect(
      thread?.messages.some(
        (message) => message.role === "assistant" && message.text === BRIEF_TEXT,
      ),
    ).toBe(true);
  }),
);

it.effect("returns a typed failure when the origin provider rejects the turn", () =>
  Effect.gen(function* () {
    const { result, sentTurns } = yield* runHandoffCase("rate-limited");

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(isHandoffBriefTurnFailedError(error)).toBe(true);
      if (isHandoffBriefTurnFailedError(error)) {
        expect(error.detail).toContain("rate-limited");
      }
    }
    expect(sentTurns).toHaveLength(1);
  }),
);
