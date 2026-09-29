import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../src/provider/Errors.ts";
import type { ProviderAdapterShape } from "../src/provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import * as ServerConfig from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const codexFailoverInstanceId = ProviderInstanceId.make("codex_failover");

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
}

interface RecordedAnalyticsEvent {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Analytics layer that keeps captured events in memory so tests can assert on
 * telemetry payloads. `AnalyticsService.layerTest` discards them.
 */
const makeRecordingAnalytics = Effect.gen(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<RecordedAnalyticsEvent>>([]);
  const layer = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: (event, properties) =>
        Ref.update(recorded, (current) => [...current, { event, properties }]),
      flush: Effect.void,
    }),
  );
  return { layer, get: Ref.get(recorded) } as const;
});

const makeIntegrationFixture = (options?: { readonly analytics?: Layer.Layer<AnalyticsService> }) =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness();

    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: harness.adapter,
    });

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntime.layer),
    );

    const shared = Layer.mergeAll(
      directoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
      ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
      options?.analytics ?? AnalyticsService.layerTest,
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
    ).pipe(Layer.provide(SqlitePersistenceMemory));

    const layer = makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(shared),
    );

    return {
      cwd,
      harness,
      layer,
    } satisfies IntegrationFixture;
  });

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* Effect.sleep("50 millis");
    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);
    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

it.live("replays typed runtime fixture events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-typed"), {
        threadId: ThreadId.make("thread-integration-typed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnTextFixture.map((event) => event.type),
      );
      assert.deepEqual(
        observedEvents.map((event) => event.providerInstanceId),
        codexTurnTextFixture.map(() => codexInstanceId),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replays file-changing fixture turn events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-tools"), {
        threadId: ThreadId.make("thread-integration-tools"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("runs multi-turn tool/approval flow", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-multi"), {
        threadId: ThreadId.make("thread-integration-multi"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      const firstTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        firstTurnEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );

      const secondTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        secondTurnEvents.map((event) => event.type),
        codexTurnApprovalFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rolls back provider conversation state only", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString, readFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(ThreadId.make("thread-integration-rollback"), {
        threadId: ThreadId.make("thread-integration-rollback"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });
      assert.equal((session.threadId ?? "").length > 0, true);

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });

      const rollbackCalls = fixture.harness.getRollbackCalls(session.threadId);
      assert.deepEqual(rollbackCalls, [1]);

      const readme = yield* readFileString(join(fixture.cwd, "README.md"));
      assert.equal(readme, "v3\n");
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports runtime mode per turn and on mode transitions", () =>
  Effect.gen(function* () {
    const analytics = yield* makeRecordingAnalytics;
    const fixture = yield* makeIntegrationFixture({ analytics: analytics.layer });
    const threadId = ThreadId.make("thread-integration-runtime-mode");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const startSession = (runtimeMode: "approval-required" | "full-access") =>
        provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: fixture.cwd,
          runtimeMode,
        });

      yield* startSession("approval-required");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "supervised turn",
        response: { events: codexTurnTextFixture },
      });

      // Toggling the mode restarts the session, which is the only place the
      // transition is observable.
      yield* startSession("full-access");
      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId,
        userText: "full access turn",
        response: { events: codexTurnTextFixture },
      });

      const recorded = yield* analytics.get;

      assert.deepEqual(
        recorded
          .filter((entry) => entry.event === "provider.turn.sent")
          .map((entry) => entry.properties?.runtimeMode),
        ["approval-required", "full-access"],
      );

      assert.deepEqual(
        recorded
          .filter((entry) => entry.event === "provider.runtime_mode.changed")
          .map((entry) => [entry.properties?.from, entry.properties?.to]),
        [["approval-required", "full-access"]],
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * Two accounts on one driver, with the target account's `startSession` held
 * open after it has registered its session. That pause is the interleaving the
 * bug needs: `ProviderService.startSession` exposes the replacement on the new
 * adapter before it stops the old session and rebinds the directory, so a
 * listing that lands in between sees the new session against the old binding.
 * The window is a few microseconds in a real run, which is why it is held
 * open explicitly rather than raced for.
 */
const makeMigrationInterleavingFixture = Effect.gen(function* () {
  const cwd = yield* makeWorkspaceDirectory;
  const origin = yield* makeTestProviderAdapterHarness();
  const target = yield* makeTestProviderAdapterHarness();

  const sessionRegistered = yield* Deferred.make<void>();
  const releaseStart = yield* Deferred.make<void>();
  const targetAdapter: ProviderAdapterShape<ProviderAdapterError> = {
    ...target.adapter,
    startSession: (input) =>
      target.adapter
        .startSession(input)
        .pipe(
          Effect.tap(() =>
            Deferred.succeed(sessionRegistered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStart)),
            ),
          ),
        ),
  };

  // Each account needs its own adapter: adapters are asked for their sessions
  // per instance, so one object serving both ids would report the same session
  // under both and there would be no mismatch to observe.
  const registry = makeAdapterRegistryMock(
    { [ProviderDriverKind.make("codex")]: origin.adapter },
    { [codexFailoverInstanceId]: targetAdapter },
  );

  const shared = Layer.mergeAll(
    ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
    Layer.succeed(ProviderAdapterRegistry, registry),
    ServerConfig.layerTest(cwd, cwd).pipe(Layer.provide(NodeServices.layer)),
    ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
    AnalyticsService.layerTest,
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provide(SqlitePersistenceMemory));

  return {
    cwd,
    origin,
    target,
    sessionRegistered,
    releaseStart,
    layer: makeProviderServiceLive().pipe(Layer.provide(NodeServices.layer), Layer.provide(shared)),
  } as const;
});

it.live("lists sessions while a migration start is mid-flight", () =>
  Effect.gen(function* () {
    const fixture = yield* makeMigrationInterleavingFixture;
    const threadId = ThreadId.make("thread-migration-interleaving");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      yield* provider.startSession(threadId, {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      const migrating = yield* Effect.forkChild(
        provider.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexFailoverInstanceId,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        }),
      );

      // The target adapter now holds a session for the thread and the directory
      // still names the origin account. Before the fix this listing died.
      yield* Deferred.await(fixture.sessionRegistered);
      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), false);

      const midFlight = (yield* exit).filter((session) => session.threadId === threadId);
      assert.deepEqual(
        midFlight.map((session) => session.providerInstanceId),
        // Bound account first: callers resolve a thread's session with `find`,
        // and until the rebind lands the thread is still on the origin.
        [codexInstanceId, codexFailoverInstanceId],
      );

      yield* Deferred.succeed(fixture.releaseStart, undefined);
      yield* Fiber.join(migrating);

      const settled = (yield* provider.listSessions()).filter(
        (session) => session.threadId === threadId,
      );
      assert.deepEqual(
        settled.map((session) => session.providerInstanceId),
        [codexFailoverInstanceId],
      );
      assert.deepEqual(fixture.origin.listActiveSessionIds(), []);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
