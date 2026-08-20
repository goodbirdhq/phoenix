import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  ThreadTurnBootstrap,
  findReusableBranchWorktree,
  hasRecoveredBootstrapThread,
  resolveWorktreeCheckoutCommit,
  setupScriptRecoveryState,
} from "./ThreadTurnBootstrap.ts";
import * as ThreadTurnBootstrapModule from "./ThreadTurnBootstrap.ts";

const gitError = (detail: string) =>
  new GitCommandError({ operation: "test", command: "git", cwd: "/repo", detail });
const isGitCommandError = Schema.is(GitCommandError);

describe("resolveWorktreeCheckoutCommit", () => {
  it.effect("reports an origin fetch failure without calling it a missing ref", () =>
    Effect.gen(function* () {
      const error = yield* Effect.exit(
        resolveWorktreeCheckoutCommit(
          {
            resolveCommit: () => Effect.fail(gitError("unknown revision")),
            remoteExists: () => Effect.succeed(true),
            fetchRemote: () => Effect.fail(gitError("authentication failed")),
            fetchPullRequestHeadCommit: () => Effect.die("not used"),
          },
          { cwd: "/repo", checkoutRef: "feature/review" },
        ),
      );

      expect(Exit.isFailure(error)).toBe(true);
      if (Exit.isFailure(error)) {
        const squashed = Cause.squash(error.cause);
        expect(squashed).toBeInstanceOf(GitCommandError);
        if (isGitCommandError(squashed)) {
          expect(squashed.detail).toBe(
            'Failed to fetch origin while resolving git ref "feature/review": Git command failed in test (/repo): authentication failed',
          );
        }
      }
    }),
  );

  it.effect("reports a missing ref only after a successful fetch", () =>
    Effect.gen(function* () {
      let resolveAttempts = 0;
      const error = yield* Effect.exit(
        resolveWorktreeCheckoutCommit(
          {
            resolveCommit: () => {
              resolveAttempts += 1;
              return Effect.fail(gitError("unknown revision"));
            },
            remoteExists: () => Effect.succeed(true),
            fetchRemote: () => Effect.void,
            fetchPullRequestHeadCommit: () => Effect.die("not used"),
          },
          { cwd: "/repo", checkoutRef: "feature/review" },
        ),
      );

      expect(resolveAttempts).toBe(2);
      expect(Exit.isFailure(error)).toBe(true);
      if (Exit.isFailure(error)) {
        const squashed = Cause.squash(error.cause);
        expect(squashed).toBeInstanceOf(GitCommandError);
        if (isGitCommandError(squashed)) {
          expect(squashed.detail).toBe(
            'Git ref "feature/review" does not exist locally or on origin.',
          );
        }
      }
    }),
  );
});

describe("findReusableBranchWorktree", () => {
  it("matches deterministic branches in short or fully-qualified form", () => {
    const worktrees = [
      { path: "/repo", branch: "main" },
      {
        path: "/repo/.worktrees/scheduled",
        branch: "refs/heads/phoenix/schedule/project/schedule/0123456789abcdef0123456789abcdef",
      },
    ];

    expect(
      findReusableBranchWorktree(
        worktrees,
        "phoenix/schedule/project/schedule/0123456789abcdef0123456789abcdef",
      )?.path,
    ).toBe("/repo/.worktrees/scheduled");
    expect(findReusableBranchWorktree(worktrees, "phoenix/schedule/other")).toBeUndefined();
  });
});

describe("hasRecoveredBootstrapThread", () => {
  it("treats a recovered deterministic Thread as cleanup-owned", () => {
    expect(
      hasRecoveredBootstrapThread({
        recoverExistingThread: {
          projectId: ProjectId.make("project-1"),
          projectCwd: "/repo",
          worktreePath: "/repo/.worktrees/scheduled",
        },
      }),
    ).toBe(true);
    expect(hasRecoveredBootstrapThread(undefined)).toBe(false);
  });
});

describe("setupScriptRecoveryState", () => {
  const key = "schedule:occurrence-1:setup";
  const activity = (kind: string) => ({ kind, payload: { idempotencyKey: key } });

  it("runs a fresh setup claim", () => {
    expect(setupScriptRecoveryState([], key)).toBe("fresh");
  });

  it("skips a completed or launched setup replay", () => {
    expect(
      setupScriptRecoveryState(
        [activity("setup-script.requested"), activity("setup-script.started")],
        key,
      ),
    ).toBe("completed");
    expect(
      setupScriptRecoveryState(
        [activity("setup-script.requested"), activity("setup-script.completed")],
        key,
      ),
    ).toBe("completed");
  });

  it("fails an indeterminate requested-only replay", () => {
    expect(setupScriptRecoveryState([activity("setup-script.requested")], key)).toBe(
      "indeterminate",
    );
  });
});

const bootstrapThreadId = ThreadId.make("schedule:018fd1b2-6610-7e39-8f09-468fa24c8c08");
const bootstrapProjectId = ProjectId.make("project-1");
const setupKey = "schedule:018fd1b2-6610-7e39-8f09-468fa24c8c08:setup";

const setupActivity = (kind: string): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${kind}`),
  tone: "info",
  kind,
  summary: "Setup state",
  payload: { idempotencyKey: setupKey },
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const recoveredThread = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThread => ({
  id: bootstrapThreadId,
  projectId: bootstrapProjectId,
  title: "Recovered Schedule Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/repo/.worktrees/schedule",
  spawnedByThreadId: null,
  reportDelivery: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  deletedAt: null,
  messages: [],
  queuedTurnStarts: [],
  proposedPlans: [],
  reports: [],
  activities,
  checkpoints: [],
  session: null,
});

const bootstrapCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("schedule:occurrence:trigger"),
  threadId: bootstrapThreadId,
  message: {
    messageId: MessageId.make("schedule:occurrence:message"),
    role: "user" as const,
    text: "Run the schedule",
    attachments: [],
  },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  bootstrap: {
    recoverExistingThread: {
      projectId: bootstrapProjectId,
      projectCwd: "/repo",
      worktreePath: "/repo/.worktrees/schedule",
    },
    runSetupScript: true,
    setupScriptIdempotencyKey: setupKey,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

const bootstrapRecoveryHarness = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
  const commands: Array<OrchestrationCommand> = [];
  const runForThread = vi.fn(() =>
    Effect.succeed({
      status: "started" as const,
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-terminal",
      cwd: "/repo/.worktrees/schedule",
    }),
  );
  const layer = ThreadTurnBootstrapModule.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
    Layer.provide(Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({ runForThread })),
    Layer.provide(Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadDetailById: () => Effect.succeed(Option.some(recoveredThread(activities))),
      }),
    ),
  );
  return { commands, runForThread, layer };
};

describe("setup-script bootstrap recovery", () => {
  it.effect("runs and durably completes a fresh claim before accepting the first Turn", () => {
    const harness = bootstrapRecoveryHarness([]);
    return Effect.gen(function* () {
      const bootstrap = yield* ThreadTurnBootstrap;
      yield* bootstrap.bootstrapTurnStart(bootstrapCommand);
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
      expect(
        harness.commands.map((command) =>
          command.type === "thread.activity.append" ? command.activity.kind : command.type,
        ),
      ).toEqual(["setup-script.requested", "setup-script.started", "thread.turn.start"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips setup only after a completed launch marker", () => {
    const harness = bootstrapRecoveryHarness([
      setupActivity("setup-script.requested"),
      setupActivity("setup-script.started"),
    ]);
    return Effect.gen(function* () {
      const bootstrap = yield* ThreadTurnBootstrap;
      yield* bootstrap.bootstrapTurnStart(bootstrapCommand);
      expect(harness.runForThread).not.toHaveBeenCalled();
      expect(harness.commands.map(({ type }) => type)).toEqual(["thread.turn.start"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails and cleans up an indeterminate requested-only replay", () => {
    const harness = bootstrapRecoveryHarness([setupActivity("setup-script.requested")]);
    return Effect.gen(function* () {
      const bootstrap = yield* ThreadTurnBootstrap;
      const error = yield* bootstrap.bootstrapTurnStart(bootstrapCommand).pipe(Effect.flip);
      expect(error.message).toContain("indeterminate");
      expect(harness.runForThread).not.toHaveBeenCalled();
      expect(harness.commands.map(({ type }) => type)).toEqual(["thread.delete"]);
    }).pipe(Effect.provide(harness.layer));
  });
});
