/**
 * settle_session wiring tests.
 *
 * These drive the real handler against stub services, because the ordering it
 * has to get right — stop the provider, THEN settle, THEN inspect the worktree,
 * THEN delete it — is invisible to tests of the pure decision helpers.
 */
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { ProjectionThreadReportRepository } from "../../../persistence/Services/ProjectionThreadReports.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";

const PARENT_THREAD_ID = ThreadId.make("parent-thread");
const CHILD_THREAD_ID = ThreadId.make("child-thread");
const PROJECT_ID = ProjectId.make("project-1");
const WORKTREE_PATH = "/tmp/phoenix-worktrees/child";
const WORKSPACE_ROOT = "/tmp/phoenix-project";

interface HarnessOptions {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly dirtyFiles?: ReadonlyArray<string>;
}

const makeHarness = (options: HarnessOptions) => {
  // One ordered log across dispatches and git calls: "did the stop land before
  // the delete" is the whole point of this file.
  const calls: Array<string> = [];
  let sessionStatus = options.sessionStatus;

  const shell = (): OrchestrationThreadShell =>
    ({
      id: CHILD_THREAD_ID,
      projectId: PROJECT_ID,
      title: "Spawned worker",
      spawnedByThreadId: PARENT_THREAD_ID,
      branch: options.branch ?? "t3code/1a2b3c4d",
      worktreePath: options.worktreePath === undefined ? WORKTREE_PATH : options.worktreePath,
      runtimeMode: "auto",
      interactionMode: "default",
      settledAt: null,
      session: sessionStatus === null ? null : { status: sessionStatus },
    }) as unknown as OrchestrationThreadShell;

  const invocationScope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: PARENT_THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["sessions" as const]),
    issuedAt: 0,
  };

  const dispatched: Array<Record<string, unknown>> = [];
  const engine = {
    dispatch: (command: { readonly type: string }) =>
      Effect.sync(() => {
        calls.push(`dispatch:${command.type}`);
        dispatched.push(command as unknown as Record<string, unknown>);
        // The stop is what makes the session actually die; everything after
        // this point must observe a stopped session.
        if (command.type === "thread.session.stop") {
          sessionStatus = "stopped";
        }
        return undefined;
      }),
  } as unknown as typeof OrchestrationEngine.OrchestrationEngineService.Service;

  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.sync(() => (threadId === CHILD_THREAD_ID ? Option.some(shell()) : Option.none())),
    getProjectShellById: () =>
      Effect.sync(() => Option.some({ id: PROJECT_ID, workspaceRoot: WORKSPACE_ROOT })),
    getThreadDetailById: () => Effect.sync(() => Option.none()),
  } as unknown as typeof ProjectionSnapshotQuery.ProjectionSnapshotQuery.Service;

  const gitWorkflow = {
    status: () =>
      Effect.sync(() => {
        calls.push("git:status");
        return {
          workingTree: {
            files: (options.dirtyFiles ?? []).map((path) => ({
              path,
              insertions: 1,
              deletions: 0,
            })),
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 0,
          aheadOfDefaultCount: 0,
        };
      }),
    removeWorktree: () => Effect.sync(() => void calls.push("git:removeWorktree")),
    deleteRef: () => Effect.sync(() => void calls.push("git:deleteRef")),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];

  const stubs = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
    Layer.succeed(GitWorkflowService.GitWorkflowService, gitWorkflow),
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
    Layer.succeed(ProjectionThreadReportRepository, {
      listByThreadId: () => Effect.succeed([]),
      findByReportId: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionThreadReportRepository["Service"]),
    // Not exercised by settle_session; only ping_session/read_session read
    // it. Unused, so no methods are needed on the stub.
    Layer.succeed(ProviderSessionDirectory, {} as unknown as ProviderSessionDirectory["Service"]),
    NodeServices.layer,
  );

  const settle = (input: { cleanupWorktree?: boolean; force?: boolean } = {}) =>
    make.pipe(
      Effect.flatMap((handlers) =>
        handlers.settle_session({ threadId: CHILD_THREAD_ID, ...input }),
      ),
      Effect.provide(stubs),
    );

  return { calls, dispatched, settle, currentStatus: () => sessionStatus };
};

it.effect("settle_session refuses a child that is mid-turn without stopping it", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "running" });
    const error = yield* harness.settle({ cleanupWorktree: true }).pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationDeniedError");
    expect((error as { reason: string }).reason).toBe("session_still_running");
    // Live work is never interrupted on the parent's say-so.
    expect(harness.calls).toEqual([]);
  }),
);

it.effect("settle_session stops an idle-but-alive session before settling it", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "ready" });
    const result = yield* harness.settle();

    expect(result.settled).toBe(true);
    expect(harness.calls).toEqual(["dispatch:thread.session.stop", "dispatch:thread.settle"]);
    expect(harness.currentStatus()).toBe("stopped");
  }),
);

it.effect("settle_session stops immediately rather than granting a grace period", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "ready" });
    yield* harness.settle();

    const stop = harness.dispatched.find((command) => command["type"] === "thread.session.stop");
    // A grace period exists to let a working agent wrap up; settle_session has
    // already refused anything starting/running, so waiting one out would only
    // delay the settle for a session that is idle by definition.
    expect(stop?.["gracePeriodMs"]).toBeUndefined();
    expect(stop?.["requestPartialReport"]).toBe(false);
    // The stop still carries #6's audit trail rather than being anonymous.
    expect(stop?.["stopReason"]).toBe("parent_stopped");
    expect(stop?.["stoppedBy"]).toBe("parent");
  }),
);

it.effect("settle_session stops the session before it inspects or deletes the worktree", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "ready" });
    const result = yield* harness.settle({ cleanupWorktree: true });

    // The dirty check has to happen after the process is gone, or it is
    // describing a worktree something can still write to.
    expect(harness.calls).toEqual([
      "dispatch:thread.session.stop",
      "dispatch:thread.settle",
      "git:status",
      "git:removeWorktree",
      "git:deleteRef",
      "dispatch:thread.meta.update",
    ]);
    expect(result.worktree.removedWorktreePath).toBe(WORKTREE_PATH);
    expect(result.worktree.removedBranch).toBe("t3code/1a2b3c4d");
  }),
);

it.effect("settle_session does not re-stop a session that is already stopped", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped" });
    yield* harness.settle();

    expect(harness.calls).toEqual(["dispatch:thread.settle"]);
  }),
);

it.effect("settle_session refuses to delete a worktree holding uncommitted work", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped", dirtyFiles: ["src/wip.ts"] });
    const error = yield* harness.settle({ cleanupWorktree: true }).pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationWorktreeNotEmptyError");
    expect((error as { dirtyFiles: ReadonlyArray<string> }).dirtyFiles).toEqual(["src/wip.ts"]);
    // Settled, but nothing destroyed.
    expect(harness.calls).toEqual(["dispatch:thread.settle", "git:status"]);
  }),
);

it.effect("settle_session deletes a worktree holding uncommitted work when forced", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped", dirtyFiles: ["src/wip.ts"] });
    yield* harness.settle({ cleanupWorktree: true, force: true });

    // force skips the inspection entirely: the caller already decided.
    expect(harness.calls).toEqual([
      "dispatch:thread.settle",
      "git:removeWorktree",
      "git:deleteRef",
      "dispatch:thread.meta.update",
    ]);
  }),
);

it.effect("settle_session keeps a branch Phoenix did not create", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped", branch: "feature/user-work" });
    const result = yield* harness.settle({ cleanupWorktree: true });

    expect(harness.calls).not.toContain("git:deleteRef");
    expect(result.worktree.removedBranch).toBeNull();
    expect(result.worktree.keptBranch).toBe("feature/user-work");
    expect(result.worktree.detail).toContain("feature/user-work");
  }),
);

it.effect("settle_session leaves the worktree alone when cleanup was not requested", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped" });
    const result = yield* harness.settle();

    expect(harness.calls).toEqual(["dispatch:thread.settle"]);
    expect(result.worktree.keptWorktreePath).toBe(WORKTREE_PATH);
    expect(result.worktree.removedWorktreePath).toBeNull();
  }),
);
