/**
 * post_report usage wiring tests.
 *
 * Usage is captured server-side (never agent-supplied): these prove it lands
 * in both the dispatched `thread.report.post` command and the tool's
 * returned SessionReport, and that a failed usage lookup degrades instead
 * of failing the whole report post.
 */
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitRepositoryLock from "../../../git/GitRepositoryLock.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { ProjectionThreadReportRepository } from "../../../persistence/Services/ProjectionThreadReports.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";

const CALLER_THREAD_ID = ThreadId.make("caller-thread");
const PROJECT_ID = ProjectId.make("project-1");

interface HarnessOptions {
  readonly getLatestUsageActivity?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getLatestUsageActivity"];
  readonly getThreadTurnCount?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadTurnCount"];
}

const makeHarness = (options: HarnessOptions = {}) => {
  const dispatched: Array<Record<string, unknown>> = [];

  const shell: OrchestrationThreadShell = {
    id: CALLER_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Working session",
    spawnedByThreadId: null,
    branch: null,
    worktreePath: null,
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt: "2026-08-12T00:00:00.000Z",
    latestTurn: null,
    settledAt: null,
    session: { status: "running" },
  } as unknown as OrchestrationThreadShell;

  const invocationScope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: CALLER_THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["sessions" as const]),
    issuedAt: 0,
  };

  const engine = {
    dispatch: (command: Record<string, unknown>) =>
      Effect.sync(() => {
        dispatched.push(command);
        return undefined;
      }),
  } as unknown as typeof OrchestrationEngine.OrchestrationEngineService.Service;

  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.sync(() => (threadId === CALLER_THREAD_ID ? Option.some(shell) : Option.none())),
    getLatestUsageActivity: options.getLatestUsageActivity ?? (() => Effect.succeed(Option.none())),
    getThreadTurnCount: options.getThreadTurnCount ?? (() => Effect.succeed(0)),
  } as unknown as typeof ProjectionSnapshotQuery.ProjectionSnapshotQuery.Service;

  const stubs = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
    Layer.succeed(
      GitWorkflowService.GitWorkflowService,
      {} as unknown as GitWorkflowService.GitWorkflowService["Service"],
    ),
    Layer.succeed(ThreadTurnBootstrap.ThreadTurnBootstrap, {
      bootstrapTurnStart: () => Effect.void,
    } as unknown as ThreadTurnBootstrap.ThreadTurnBootstrap["Service"]),
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed([]),
    } as unknown as ProviderRegistry.ProviderRegistryShape),
    Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
    } as unknown as ServerRuntimeStartup.ServerRuntimeStartup["Service"]),
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({ enableSessionOrchestration: true }),
    } as unknown as ServerSettings.ServerSettingsService["Service"]),
    Layer.succeed(
      ProjectionThreadReportRepository,
      {} as unknown as ProjectionThreadReportRepository["Service"],
    ),
    Layer.succeed(ProviderSessionDirectory, {} as unknown as ProviderSessionDirectory["Service"]),
    // Only settle_session's cleanup path reaches these two; post_report that
    // touches them is a bug, so the stubs stay empty.
    Layer.succeed(
      SourceControlProviderRegistry.SourceControlProviderRegistry,
      {} as unknown as SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
    ),
    GitRepositoryLock.layer.pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );

  const postReport = () =>
    make.pipe(
      Effect.flatMap((handlers) =>
        handlers.post_report({ status: "success", title: "Done", summary: "Finished the task." }),
      ),
      Effect.provide(stubs),
    );

  return { dispatched, postReport };
};

it.effect(
  "post_report captures a usage snapshot in both the dispatched command and the result",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        getLatestUsageActivity: () =>
          Effect.succeed(
            Option.some({ inputTokens: 200, outputTokens: 80, totalProcessedTokens: 900 }),
          ),
        getThreadTurnCount: () => Effect.succeed(5),
      });

      const result = yield* harness.postReport();

      expect(result.usage).toBeDefined();
      expect(result.usage?.lastTurnInputTokens).toBe(200);
      expect(result.usage?.lastTurnOutputTokens).toBe(80);
      expect(result.usage?.totalTokens).toBe(900);
      expect(result.usage?.turnCount).toBe(5);

      const dispatchedReport = harness.dispatched.find(
        (command) => command["type"] === "thread.report.post",
      );
      expect(dispatchedReport?.["usage"]).toEqual(result.usage);
    }),
);

it.effect(
  "post_report still succeeds with an elapsedMs-only usage snapshot when the reads fail",
  () =>
    Effect.gen(function* () {
      const failure = new PersistenceSqlError({ operation: "test", detail: "unavailable" });
      const harness = makeHarness({
        getLatestUsageActivity: () => Effect.fail(failure),
        getThreadTurnCount: () => Effect.fail(failure),
      });

      const result = yield* harness.postReport();

      expect(result.usage).toEqual({ elapsedMs: expect.any(Number) });
    }),
);
