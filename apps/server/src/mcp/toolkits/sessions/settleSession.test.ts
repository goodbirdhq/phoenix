/**
 * settle_session wiring tests.
 *
 * These drive the real handler against stub services, because the ordering it
 * has to get right — stop the provider, THEN settle, THEN inspect the worktree,
 * THEN delete it — is invisible to tests of the pure decision helpers. The same
 * goes for the two properties added after the first real-world cleanup run:
 * that concurrent cleanups on one repository queue instead of racing git's
 * lock, and that a branch is only ever deleted against a merge proof.
 */
import {
  type ChangeRequest,
  EnvironmentId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  ThreadId,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as GitRepositoryLock from "../../../git/GitRepositoryLock.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { ProjectionThreadReportRepository } from "../../../persistence/Services/ProjectionThreadReports.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProvider from "../../../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";

const PARENT_THREAD_ID = ThreadId.make("parent-thread");
const CHILD_THREAD_ID = ThreadId.make("child-thread");
const PROJECT_ID = ProjectId.make("project-1");
const WORKTREE_PATH = "/tmp/phoenix-worktrees/child";
const WORKSPACE_ROOT = "/tmp/phoenix-project";
const BRANCH_HEAD_SHA = "1111111111111111111111111111111111111111";

const workspaceRootFor = (projectId: ProjectId) =>
  projectId === PROJECT_ID ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}-${projectId}`;

const mergedPullRequest = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  provider: "github",
  number: 42,
  title: "Ship the thing",
  url: "https://github.com/goodbirdhq/phoenix/pull/42",
  baseRefName: "main",
  headRefName: "feature/user-work",
  state: "merged",
  updatedAt: Option.none(),
  headRefOid: BRANCH_HEAD_SHA,
  ...overrides,
});

const gitFailure = (detail: string) =>
  new GitCommandError({
    operation: "GitVcsDriver.removeWorktree",
    command: "git",
    cwd: WORKSPACE_ROOT,
    detail,
  });

interface HarnessChild {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string;
  readonly branch?: string;
}

interface HarnessOptions {
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly dirtyFiles?: ReadonlyArray<string>;
  /** Extra children, for the concurrency cases. All share `sessionStatus`. */
  readonly children?: ReadonlyArray<HarnessChild>;
  /** A stop request that never lands, so the stop wait runs out. */
  readonly stopHangs?: boolean;
  /** Fails `git worktree remove` with this detail instead of succeeding. */
  readonly removeWorktreeFailure?: string;
  /** Merged pull requests the host reports for the branch; null = host down. */
  readonly mergedPullRequests?: ReadonlyArray<ChangeRequest> | null;
  /** Local head of the child's branch. */
  readonly localSha?: string;
  /** Remote-tracking head; null means there is no remote-tracking ref. */
  readonly remoteSha?: string | null;
}

const makeHarness = (options: HarnessOptions) => {
  // One ordered log across dispatches and git calls: "did the stop land before
  // the delete" is the whole point of this file.
  const calls: Array<string> = [];
  let sessionStatus = options.sessionStatus;
  let worktreeRemovalsInFlight = 0;
  let maxWorktreeRemovalsInFlight = 0;

  const children: ReadonlyArray<HarnessChild> = options.children ?? [{ threadId: CHILD_THREAD_ID }];

  const shell = (child: HarnessChild): OrchestrationThreadShell =>
    ({
      id: child.threadId,
      projectId: child.projectId ?? PROJECT_ID,
      title: "Spawned worker",
      spawnedByThreadId: PARENT_THREAD_ID,
      branch: child.branch ?? options.branch ?? "t3code/1a2b3c4d",
      worktreePath:
        child.worktreePath ??
        (options.worktreePath === undefined ? WORKTREE_PATH : options.worktreePath),
      runtimeMode: "auto",
      interactionMode: "default",
      settledAt: null,
      session:
        sessionStatus === null
          ? null
          : { status: sessionStatus, providerName: "codex", threadId: child.threadId },
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
        // this point must observe a stopped session — unless the test is
        // reproducing a process that refuses to go.
        if (command.type === "thread.session.stop" && options.stopHangs !== true) {
          sessionStatus = "stopped";
        }
        return undefined;
      }),
  } as unknown as typeof OrchestrationEngine.OrchestrationEngineService.Service;

  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.sync(() => {
        const child = children.find((candidate) => candidate.threadId === threadId);
        return child === undefined ? Option.none() : Option.some(shell(child));
      }),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.sync(() => Option.some({ id: projectId, workspaceRoot: workspaceRootFor(projectId) })),
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
    removeWorktree: () =>
      Effect.gen(function* () {
        worktreeRemovalsInFlight += 1;
        maxWorktreeRemovalsInFlight = Math.max(
          maxWorktreeRemovalsInFlight,
          worktreeRemovalsInFlight,
        );
        calls.push("git:removeWorktree");
        // Hand the scheduler several chances to run another fiber here.
        // Without the repository lock every parallel cleanup would be inside
        // this window at once, which is exactly the contention being fixed.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        worktreeRemovalsInFlight -= 1;
        if (options.removeWorktreeFailure !== undefined) {
          return yield* Effect.fail(gitFailure(options.removeWorktreeFailure));
        }
      }),
    deleteRef: () => Effect.sync(() => void calls.push("git:deleteRef")),
    resolveCommit: () =>
      Effect.sync(() => {
        calls.push("git:resolveCommit");
        return { commitSha: options.localSha ?? BRANCH_HEAD_SHA };
      }),
    resolveRemoteTrackingCommit: (input: { readonly refName: string }) =>
      Effect.suspend(() => {
        calls.push("git:resolveRemoteTrackingCommit");
        const remoteSha = options.remoteSha === undefined ? BRANCH_HEAD_SHA : options.remoteSha;
        return remoteSha === null
          ? Effect.fail(gitFailure("unknown revision"))
          : Effect.succeed({ commitSha: remoteSha, remoteRefName: `origin/${input.refName}` });
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];

  const sourceControlProviders = {
    resolve: () =>
      Effect.suspend(() => {
        calls.push("sourceControl:resolve");
        if (options.mergedPullRequests === null) {
          return Effect.fail(
            new SourceControlProviderError({
              provider: "github",
              operation: "resolve",
              cwd: WORKSPACE_ROOT,
              detail: "GitHub CLI (`gh`) is required but not available on PATH.",
            }),
          );
        }
        return Effect.succeed({
          kind: "github" as const,
          listChangeRequests: () => Effect.succeed(options.mergedPullRequests ?? []),
        } as unknown as SourceControlProvider.SourceControlProvider["Service"]);
      }),
  } as unknown as SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];

  const stubs = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
    Layer.succeed(GitWorkflowService.GitWorkflowService, gitWorkflow),
    Layer.succeed(
      SourceControlProviderRegistry.SourceControlProviderRegistry,
      sourceControlProviders,
    ),
    // The real lock: serialization is the behavior under test, and one
    // instance per harness is what makes parallel settles queue on each other.
    GitRepositoryLock.layer,
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

  // Builds the handlers — and therefore the repository lock — exactly once, so
  // concurrent calls in a test share the lock the way they share it in a
  // running server.
  const withHandlers = <A, E, R>(
    use: (handlers: Effect.Success<typeof make>) => Effect.Effect<A, E, R>,
  ) => make.pipe(Effect.flatMap(use), Effect.provide(stubs));

  const settle = (
    input: {
      threadId?: ThreadId;
      cleanupWorktree?: boolean;
      cleanupBranch?: boolean;
      force?: boolean;
    } = {},
  ) => withHandlers((handlers) => handlers.settle_session({ threadId: CHILD_THREAD_ID, ...input }));

  return {
    calls,
    dispatched,
    settle,
    withHandlers,
    currentStatus: () => sessionStatus,
    maxWorktreeRemovalsInFlight: () => maxWorktreeRemovalsInFlight,
  };
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
    expect(result.warning).toBeNull();
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
    expect(result.worktree.branchProof).toContain("temporary worktree branch");
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
    expect(result.worktree.branchProof).toBeNull();
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

const parallelChildren = Array.from({ length: 8 }, (_, index) => ({
  threadId: ThreadId.make(`child-${index}`),
  worktreePath: `/tmp/phoenix-worktrees/child-${index}`,
}));

it.effect("settle_session serializes worktree cleanup across parallel calls on one repo", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped", children: parallelChildren });

    const results = yield* harness.withHandlers((handlers) =>
      Effect.all(
        parallelChildren.map((child) =>
          handlers.settle_session({ threadId: child.threadId, cleanupWorktree: true }),
        ),
        { concurrency: "unbounded" },
      ),
    );

    // All eight succeed. Before the lock, eight concurrent `git worktree
    // remove` runs on one repository all timed out waiting for .git/index.lock
    // and only a lone sequential retry got through.
    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.settled).toBe(true);
      expect(result.worktree.removedWorktreePath).not.toBeNull();
    }
    expect(harness.maxWorktreeRemovalsInFlight()).toBe(1);
    // Each removal is immediately followed by its own branch delete: the ref
    // delete is inside the same critical section, not interleaved with the
    // next child's removal.
    const mutations = harness.calls.filter(
      (call) => call === "git:removeWorktree" || call === "git:deleteRef",
    );
    expect(mutations).toEqual(
      parallelChildren.flatMap(() => ["git:removeWorktree", "git:deleteRef"]),
    );
  }),
);

it.effect("settle_session does not serialize cleanups of different repositories", () =>
  Effect.gen(function* () {
    const children = [
      {
        threadId: ThreadId.make("child-a"),
        projectId: ProjectId.make("project-a"),
        worktreePath: "/tmp/phoenix-worktrees/child-a",
      },
      {
        threadId: ThreadId.make("child-b"),
        projectId: ProjectId.make("project-b"),
        worktreePath: "/tmp/phoenix-worktrees/child-b",
      },
    ];
    const harness = makeHarness({ sessionStatus: "stopped", children });

    yield* harness.withHandlers((handlers) =>
      Effect.all(
        children.map((child) =>
          handlers.settle_session({ threadId: child.threadId, cleanupWorktree: true }),
        ),
        { concurrency: "unbounded" },
      ),
    );

    // The lock is per repository, not global: unrelated repositories have no
    // reason to queue behind each other.
    expect(harness.maxWorktreeRemovalsInFlight()).toBe(2);
  }),
);

it.effect("settle_session reports a held git lock with its path and a remedy", () =>
  Effect.gen(function* () {
    const lockPath = "/tmp/phoenix-project/.git/index.lock";
    const harness = makeHarness({
      sessionStatus: "stopped",
      removeWorktreeFailure: `Unable to create '${lockPath}': File exists.`,
    });

    const error = yield* harness.settle({ cleanupWorktree: true }).pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationGitLockError");
    expect((error as { lockPath: string }).lockPath).toBe(lockPath);
    expect((error as { remedy: string }).remedy).toContain(lockPath);
    // The file does not exist, so nothing about it can be called stale — and
    // Phoenix never removes it either way.
    expect((error as { appearsStale: boolean }).appearsStale).toBe(false);
    expect(error.message).toContain(lockPath);
  }),
);

it.effect("settle_session still reports an ordinary worktree failure as an operation error", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      removeWorktreeFailure: "'/tmp/phoenix-worktrees/child' contains modified files",
    });

    const error = yield* harness.settle({ cleanupWorktree: true }).pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationOperationError");
    expect(error.message).toContain("still on disk");
  }),
);

it.effect("settle_session deletes a custom branch proven merged by a merged PR head", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      mergedPullRequests: [mergedPullRequest()],
    });

    const result = yield* harness.settle({ cleanupWorktree: true, cleanupBranch: true });

    expect(result.worktree.removedBranch).toBe("feature/user-work");
    expect(result.worktree.branchProof).toContain("#42");
    expect(result.worktree.branchProof).toContain(BRANCH_HEAD_SHA);
    // The proof runs before anything is destroyed.
    expect(harness.calls.indexOf("sourceControl:resolve")).toBeLessThan(
      harness.calls.indexOf("git:removeWorktree"),
    );
  }),
);

it.effect("settle_session refuses a custom branch with no merged pull request", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      mergedPullRequests: [],
    });

    const error = yield* harness
      .settle({ cleanupWorktree: true, cleanupBranch: true })
      .pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationBranchNotMergedError");
    expect((error as { reason: string }).reason).toBe("no_merged_pull_request");
    // Nothing destroyed: the proof gates the whole cleanup, not just the ref.
    expect(harness.calls).not.toContain("git:removeWorktree");
  }),
);

it.effect("settle_session refuses a custom branch merged from a different commit", () =>
  Effect.gen(function* () {
    // The trap this whole proof exists for: on a squash-merging repo the
    // branch is never an ancestor of main, so only the PR's head commit can
    // say whether *this* branch head is what got merged.
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      mergedPullRequests: [mergedPullRequest({ headRefOid: "9".repeat(40) })],
    });

    const error = yield* harness
      .settle({ cleanupWorktree: true, cleanupBranch: true })
      .pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationBranchNotMergedError");
    expect((error as { reason: string }).reason).toBe("pull_request_head_mismatch");
    expect((error as { mergedPullRequestNumber: number | null }).mergedPullRequestNumber).toBe(42);
    expect(harness.calls).not.toContain("git:removeWorktree");
  }),
);

it.effect("settle_session refuses a custom branch whose local head is unpushed", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      localSha: "2".repeat(40),
      remoteSha: BRANCH_HEAD_SHA,
      mergedPullRequests: [mergedPullRequest()],
    });

    const error = yield* harness
      .settle({ cleanupWorktree: true, cleanupBranch: true })
      .pipe(Effect.flip);

    expect(error._tag).toBe("SessionOrchestrationBranchNotMergedError");
    expect((error as { reason: string }).reason).toBe("local_ahead_of_remote");
    // The host is never asked: the branch already failed on local evidence.
    expect(harness.calls).not.toContain("sourceControl:resolve");
  }),
);

it.effect("settle_session refuses a custom branch with no remote-tracking ref", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      remoteSha: null,
      mergedPullRequests: [mergedPullRequest()],
    });

    const error = yield* harness
      .settle({ cleanupWorktree: true, cleanupBranch: true })
      .pipe(Effect.flip);

    expect((error as { reason: string }).reason).toBe("remote_branch_missing");
  }),
);

it.effect("settle_session refuses a custom branch when the pull request host is unreachable", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      sessionStatus: "stopped",
      branch: "feature/user-work",
      mergedPullRequests: null,
    });

    const error = yield* harness
      .settle({ cleanupWorktree: true, cleanupBranch: true })
      .pipe(Effect.flip);

    expect((error as { reason: string }).reason).toBe("pull_request_lookup_unavailable");
    expect(harness.calls).not.toContain("git:removeWorktree");
  }),
);

it.effect("settle_session rejects cleanupBranch without cleanupWorktree", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "stopped", branch: "feature/user-work" });
    const error = yield* harness.settle({ cleanupBranch: true }).pipe(Effect.flip);

    // git refuses to delete a branch that is checked out in a worktree, so
    // asking for one without the other can never do what the caller meant.
    expect(error._tag).toBe("SessionOrchestrationInvalidInputError");
    expect(error.message).toContain("cleanupWorktree");
  }),
);

it.effect("settle_session warns when the child's process outlives the stop wait", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "ready", stopHangs: true });

    const fiber = yield* Effect.forkChild(harness.settle());
    // The stop wait is a poll loop, so the clock has to be walked past it.
    yield* TestClock.adjust(Duration.seconds(10));
    const result = yield* Fiber.join(fiber);

    // The thread still settles — the settle is the reversible half — but a
    // process that refused to die is no longer a silent success.
    expect(result.settled).toBe(true);
    expect(result.warning).toContain("codex");
    expect(result.warning).toContain("ready");
    expect(harness.calls).toContain("dispatch:thread.settle");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("settle_session still withholds cleanup when the stop wait times out", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ sessionStatus: "ready", stopHangs: true });

    const fiber = yield* Effect.forkChild(
      harness.settle({ cleanupWorktree: true }).pipe(Effect.flip),
    );
    yield* TestClock.adjust(Duration.seconds(10));
    const error = yield* Fiber.join(fiber);

    expect(error._tag).toBe("SessionOrchestrationOperationError");
    expect(error.message).toContain("left untouched");
    expect(harness.calls).not.toContain("git:removeWorktree");
  }).pipe(Effect.provide(TestClock.layer())),
);
