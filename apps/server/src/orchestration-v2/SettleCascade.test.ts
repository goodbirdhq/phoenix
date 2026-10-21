import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "settle-cascade" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:settle-cascade"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

/** Ends a thread's runs in the projection; nothing here reaches a provider. */
const completeRuns = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    for (const run of (yield* orchestrator.getThreadProjection(threadId)).runs) {
      yield* projections.apply({
        id: EventId.make(`event:${run.id}:completed`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
    }
  });

/** Parent with children A and B, and grandchild A1 under A. */
const createTree = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make(`thread:${prefix}:parent`);
    yield* createThread(parent);
    const childA = yield* delegate(parent, `${prefix} child a`);
    const childB = yield* delegate(parent, `${prefix} child b`);
    const grandchild = yield* delegate(childA, `${prefix} grandchild`);
    // The provider never runs here, so drop the turn starts delegation queued.
    yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
    return { parent, childA, childB, grandchild };
  });

const organize = (threadId: ThreadId, type: "thread.settle" | "thread.archive", attempt = 1) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type,
      commandId: CommandId.make(`${type}:${threadId}:${attempt}`),
      threadId,
    });
    yield* worker.drain();
  });

const state = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    return thread.archivedAt !== null
      ? "archived"
      : thread.settledOverride === "settled"
        ? "settled"
        : "active";
  });

it.effect("settling a parent settles its child sessions and theirs", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const tree = yield* createTree("settle");
    for (const threadId of Object.values(tree)) yield* completeRuns(threadId);
    yield* organize(tree.childB, "thread.settle");
    const childBSettled = yield* orchestrator.getThreadRecords(tree.childB, []);
    const childBSequence = yield* orchestrator.getThreadEventSequence(tree.childB);

    yield* organize(tree.parent, "thread.settle");

    for (const threadId of Object.values(tree)) assert.equal(yield* state(threadId), "settled");
    assert.equal(yield* orchestrator.getThreadEventSequence(tree.childB), childBSequence);
    assert.deepEqual(
      (yield* orchestrator.getThreadRecords(tree.childB, [])).thread.settledAt,
      childBSettled.thread.settledAt,
    );

    // Settling again walks the children but finds nothing left to settle.
    const sequences = yield* Effect.forEach(Object.values(tree), (threadId) =>
      orchestrator.getThreadEventSequence(threadId),
    );
    yield* organize(tree.parent, "thread.settle", 2);
    assert.deepEqual(
      yield* Effect.forEach(Object.values(tree).slice(1), (threadId) =>
        orchestrator.getThreadEventSequence(threadId),
      ),
      sequences.slice(1),
    );

    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle:parent"),
      threadId: tree.parent,
      reason: "user",
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    assert.equal(yield* state(tree.parent), "active");
    assert.equal(yield* state(tree.childA), "settled");
    assert.equal(yield* state(tree.grandchild), "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("archiving a parent archives its child sessions and theirs", () =>
  Effect.gen(function* () {
    const tree = yield* createTree("archive");
    for (const threadId of Object.values(tree)) yield* completeRuns(threadId);

    yield* organize(tree.parent, "thread.archive");

    for (const threadId of Object.values(tree)) assert.equal(yield* state(threadId), "archived");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settling a parent leaves a running child session and provider subagents alone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const tree = yield* createTree("partial");
    yield* completeRuns(tree.parent);
    yield* completeRuns(tree.childB);
    const nativeChild = ThreadId.make("thread:partial:native");
    yield* createThread(nativeChild);
    yield* completeRuns(nativeChild);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
    const task = (yield* orchestrator.getThreadProjection(tree.parent)).subagents[0]!;
    yield* projections.apply({
      id: EventId.make("event:partial:native-subagent"),
      type: "subagent.updated",
      threadId: tree.parent,
      runId: task.runId!,
      nodeId: NodeId.make("node:partial:native"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:partial:native"),
        origin: "provider_native",
        childThreadId: nativeChild,
      },
    });

    yield* organize(tree.parent, "thread.settle");

    assert.equal(yield* state(tree.parent), "settled");
    assert.equal(yield* state(tree.childB), "settled");
    assert.equal(yield* state(tree.childA), "active");
    assert.equal(yield* state(tree.grandchild), "active");
    assert.equal(yield* state(nativeChild), "active");
    // A child the cascade had to leave is not a failure to retry.
    const outbox = yield* sql<{ readonly effect_type: string; readonly status: string }>`
      SELECT effect_type, status FROM orchestration_v2_effect_outbox
    `;
    assert.deepEqual(
      outbox.map((row) => ({ ...row })),
      [{ effect_type: "delegated-tasks.organize", status: "succeeded" }],
    );
  }).pipe(Effect.provide(layerTest)),
);
