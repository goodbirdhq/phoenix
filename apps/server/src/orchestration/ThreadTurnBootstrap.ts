import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  GitCommandError,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  type ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type WorktreeSetupSnapshot,
  worktreeSetupActivityId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";

export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isSetupScriptActivityPayload = Schema.is(Schema.Struct({ idempotencyKey: Schema.String }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unexpected error variant: ${JSON.stringify(error)}`);
}

function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isOrchestrationDispatchCommandError(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

type WorktreeCheckoutGitWorkflow = Pick<
  GitWorkflowService.GitWorkflowService["Service"],
  "fetchPullRequestHeadCommit" | "fetchRemote" | "remoteExists" | "resolveCommit"
>;

const errorDetail = (error: unknown) => (error instanceof Error ? error.message : String(error));

const checkoutGitError = (input: { readonly cwd: string }, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "ThreadTurnBootstrap.resolveWorktreeCheckoutCommit",
    command: "git",
    cwd: input.cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

export const resolveWorktreeCheckoutCommit = (
  gitWorkflow: WorktreeCheckoutGitWorkflow,
  input: {
    readonly cwd: string;
    readonly checkoutRef: string;
    readonly checkoutPr?: number | undefined;
  },
) => {
  if (input.checkoutPr !== undefined) {
    return gitWorkflow.fetchPullRequestHeadCommit({
      cwd: input.cwd,
      prNumber: input.checkoutPr,
    });
  }

  return gitWorkflow.resolveCommit({ cwd: input.cwd, revision: input.checkoutRef }).pipe(
    Effect.catch((localResolveError) =>
      gitWorkflow.remoteExists({ cwd: input.cwd, remoteName: "origin" }).pipe(
        Effect.flatMap((hasOrigin) =>
          hasOrigin
            ? gitWorkflow.fetchRemote({ cwd: input.cwd, remoteName: "origin" }).pipe(
                Effect.mapError((error) =>
                  checkoutGitError(
                    input,
                    `Failed to fetch origin while resolving git ref "${input.checkoutRef}": ${errorDetail(error)}`,
                    error,
                  ),
                ),
                Effect.andThen(
                  gitWorkflow
                    .resolveCommit({ cwd: input.cwd, revision: input.checkoutRef })
                    .pipe(
                      Effect.mapError((error) =>
                        checkoutGitError(
                          input,
                          `Git ref "${input.checkoutRef}" does not exist locally or on origin.`,
                          error,
                        ),
                      ),
                    ),
                ),
              )
            : Effect.fail(
                checkoutGitError(
                  input,
                  `Git ref "${input.checkoutRef}" does not exist locally and this project has no origin remote to fetch.`,
                  localResolveError,
                ),
              ),
        ),
      ),
    ),
  );
};

export function findReusableBranchWorktree(
  worktrees: ReadonlyArray<{ readonly path: string; readonly branch: string }>,
  branch: string,
): { readonly path: string; readonly branch: string } | undefined {
  const canonicalBranch = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  return worktrees.find(
    (worktree) =>
      worktree.branch === branch ||
      worktree.branch === canonicalBranch ||
      `refs/heads/${worktree.branch}` === canonicalBranch,
  );
}

export function hasRecoveredBootstrapThread(
  bootstrap: ThreadTurnStartCommand["bootstrap"],
): boolean {
  return bootstrap?.recoverExistingThread !== undefined;
}

export type SetupScriptRecoveryState = "fresh" | "indeterminate" | "completed";

export function setupScriptRecoveryState(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  idempotencyKey: string,
): SetupScriptRecoveryState {
  const matching = activities.filter(
    ({ kind, payload }) =>
      kind.startsWith("setup-script.") &&
      isSetupScriptActivityPayload(payload) &&
      payload.idempotencyKey === idempotencyKey,
  );
  if (
    matching.some(({ kind }) =>
      ["setup-script.started", "setup-script.completed", "setup-script.failed"].includes(kind),
    )
  ) {
    return "completed";
  }
  return matching.some(({ kind }) => kind === "setup-script.requested") ? "indeterminate" : "fresh";
}

type BootstrapDispatchOptions = { readonly origin?: OrchestrationClientOrigin };

// Runs the "create thread + prepare worktree + setup script + first turn"
// macro behind `thread.turn.start` bootstrap payloads. Shared by the WS
// dispatch path, schedules, and the sessions MCP toolkit so all of them get
// the same worktree setup progress, cancel, and rollback behavior.
export class ThreadTurnBootstrap extends Context.Service<
  ThreadTurnBootstrap,
  {
    readonly bootstrapTurnStart: (
      command: ThreadTurnStartCommand,
      options?: BootstrapDispatchOptions,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
    readonly cleanupRecoveredThread: (
      threadId: ThreadId,
    ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/ThreadTurnBootstrap") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Failed to generate orchestration command identifier.",
          cause,
        }),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly origin?: BootstrapDispatchOptions | undefined;
    readonly kind:
      | "setup-script.requested"
      | "setup-script.started"
      | "setup-script.completed"
      | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch(
          {
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          },
          input.origin,
        ),
      ),
    );

  // The worktree setup's durable record: one activity per thread, upserted
  // by a fixed id when the setup starts and again when it settles. Live
  // progress keeps streaming from the tracker; this is what a reload or
  // another client reads. Best effort: the thread may already be gone
  // after a failed bootstrap.
  const recordWorktreeSetup = (
    snapshot: WorktreeSetupSnapshot,
    options: BootstrapDispatchOptions | undefined,
  ) =>
    serverCommandId("worktree-setup-activity").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch(
          {
            type: "thread.activity.append",
            commandId,
            threadId: snapshot.threadId,
            activity: {
              id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
              tone:
                snapshot.phase === "failed" ||
                snapshot.stages.some((stage) => stage.status === "failed")
                  ? "error"
                  : "info",
              kind: WORKTREE_SETUP_ACTIVITY_KIND,
              summary:
                snapshot.phase === "running"
                  ? "Setting up worktree"
                  : snapshot.phase === "done"
                    ? "Worktree ready"
                    : snapshot.phase === "cancelled"
                      ? "Worktree setup cancelled"
                      : "Worktree setup failed",
              payload: snapshot,
              turnId: null,
              createdAt: snapshot.startedAt,
            },
            createdAt: snapshot.endedAt ?? snapshot.startedAt,
          },
          options,
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

  // Project setting > environment setting; null when neither is set so
  // the driver reads the freshly created checkout's own t3.json (the
  // branch being checked out may declare something the project root does
  // not). Settings that fail to load fall through the same way.
  const resolveBootstrapWorktreeSubmodules = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return null;
    // A worktree can also be prepared for an existing thread, whose
    // project is only known through its shell.
    const resolvedProjectId =
      input.projectId ??
      (yield* projection.getThreadShellById(input.threadId).pipe(
        Effect.map((thread) => Option.getOrNull(thread)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    const project =
      resolvedProjectId === null
        ? null
        : yield* projection.getProjectShellById(resolvedProjectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
    return resolveProjectSettings(settings, resolvedProjectId, project).settings.worktreeSubmodules;
  });

  const bootstrapTurnStart: ThreadTurnBootstrap["Service"]["bootstrapTurnStart"] = Effect.fn(
    "ThreadTurnBootstrap.bootstrapTurnStart",
  )(function* (command, options) {
    const bootstrap = command.bootstrap;
    const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
    const threadId = command.threadId;
    const prepareWorktree = bootstrap?.prepareWorktree;
    const dispatch = (next: OrchestrationCommand) => orchestrationEngine.dispatch(next, options);
    // A retry owns the deterministic Thread left by its interrupted first
    // attempt, so a later non-interrupt failure must clean it up too.
    let createdThread = hasRecoveredBootstrapThread(bootstrap);
    const targetProjectId =
      bootstrap?.createThread?.projectId ?? bootstrap?.recoverExistingThread?.projectId;
    const targetProjectCwd =
      prepareWorktree?.projectCwd ?? bootstrap?.recoverExistingThread?.projectCwd;
    let targetWorktreePath =
      bootstrap?.createThread?.worktreePath ??
      bootstrap?.recoverExistingThread?.worktreePath ??
      null;
    // Only a worktree this attempt claimed is removed on cancel; a reused or
    // caller-provided checkout is not ours to delete.
    let createdWorktreePath: string | null = null;
    // The setup script's terminal, once started. Cancel closes only this
    // one so terminals the user opened meanwhile survive.
    let setupTerminalId: string | null = null;
    // Set once the checkout starts; see the session.set below.
    let preparingSessionSet = false;

    // Worktree bootstraps report per-stage progress and can be cancelled by
    // the user through the tracker. Everything else keeps the plain path.
    const tracked = prepareWorktree !== undefined;
    const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);
    const settleTracked = (phase: "done" | "failed" | "cancelled", error?: string) =>
      track(
        worktreeSetupTracker
          .finish(threadId, phase, error)
          .pipe(
            Effect.flatMap((snapshot) =>
              snapshot ? recordWorktreeSetup(snapshot, options) : Effect.void,
            ),
          ),
      );
    // An explicit ref or PR has no project-checkout equivalent, so it can
    // never fall back to running in the project root.
    const hasExplicitCheckout =
      prepareWorktree?.checkoutRef !== undefined || prepareWorktree?.checkoutPr !== undefined;
    const requireWorktree = prepareWorktree?.requireWorktree === true || hasExplicitCheckout;

    const markPreparingSessionFailed = (detail: string) =>
      Effect.gen(function* () {
        const failedAt = yield* nowIso;
        yield* dispatch({
          type: "thread.session.set",
          commandId: yield* serverCommandId("bootstrap-thread-preparing-failed"),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: null,
            providerInstanceId:
              bootstrap?.createThread?.modelSelection.instanceId ??
              command.modelSelection?.instanceId,
            runtimeMode: command.runtimeMode,
            activeTurnId: null,
            lastError: detail.trim().length > 0 ? detail : "Worktree setup failed.",
            updatedAt: failedAt,
          },
          createdAt: failedAt,
        });
      });

    const cleanupCreatedThread = () =>
      createdThread
        ? serverCommandId("bootstrap-thread-delete").pipe(
            Effect.flatMap((commandId) =>
              dispatch({
                type: "thread.delete",
                commandId,
                threadId,
              }),
            ),
            Effect.as(true),
          )
        : Effect.succeed(false);

    const recordSetupScriptLaunchFailure = (input: {
      readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
      readonly requestedAt: string;
      readonly worktreePath: string;
    }) => {
      const detail = projectSetupScriptCompatibilityDetail(input.error);
      return appendSetupScriptActivity({
        threadId,
        origin: options,
        kind: "setup-script.failed",
        summary: "Setup script failed to start",
        createdAt: input.requestedAt,
        payload: {
          detail,
          worktreePath: input.worktreePath,
          ...(bootstrap?.setupScriptIdempotencyKey === undefined
            ? {}
            : { idempotencyKey: bootstrap.setupScriptIdempotencyKey }),
        },
        tone: "error",
      }).pipe(
        Effect.ignoreCause({ log: false }),
        Effect.flatMap(() =>
          Effect.logWarning("bootstrap turn start failed to launch setup script", {
            threadId,
            worktreePath: input.worktreePath,
            detail,
          }),
        ),
      );
    };

    const recordSetupScriptStarted = (input: {
      readonly requestedAt: string;
      readonly worktreePath: string;
      readonly scriptId: string;
      readonly scriptName: string;
      readonly terminalId: string;
    }) =>
      Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
          ...(bootstrap?.setupScriptIdempotencyKey === undefined
            ? {}
            : { idempotencyKey: bootstrap.setupScriptIdempotencyKey }),
        };
        const startedActivity = appendSetupScriptActivity({
          threadId,
          origin: options,
          kind: "setup-script.started",
          summary: "Setup script started",
          createdAt: startedAt,
          payload,
          tone: "info",
        });
        yield* Effect.all(
          bootstrap?.setupScriptIdempotencyKey === undefined
            ? [
                appendSetupScriptActivity({
                  threadId,
                  origin: options,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                startedActivity,
              ]
            : [startedActivity],
        ).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning(
              "bootstrap turn start launched setup script but failed to record setup activity",
              {
                threadId,
                worktreePath: input.worktreePath,
                scriptId: input.scriptId,
                terminalId: input.terminalId,
                detail: error.message,
              },
            ),
          ),
        );
      });

    // Starts the setup script. For tracked bootstraps it returns the effect
    // that waits for the script to exit and records the outcome on the card;
    // whether the agent stage waits on it depends on the script's `async`
    // flag. Returns null when nothing is left to await. Untracked callers keep
    // the fire-and-forget behavior.
    const runSetupProgram = () =>
      Effect.gen(function* () {
        if (!bootstrap?.runSetupScript || !targetWorktreePath) {
          yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped"));
          return null;
        }
        const worktreePath = targetWorktreePath;
        const requestedAt = yield* nowIso;
        const idempotencyKey = bootstrap.setupScriptIdempotencyKey;
        if (idempotencyKey !== undefined) {
          const existing = yield* projection.getThreadDetailById(threadId);
          const recoveryState = Option.isSome(existing)
            ? setupScriptRecoveryState(existing.value.activities, idempotencyKey)
            : "fresh";
          if (recoveryState === "completed") {
            yield* track(
              worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped", "already ran"),
            );
            return null;
          }
          if (recoveryState === "indeterminate") {
            return yield* new OrchestrationDispatchCommandError({
              message: "Setup script launch state is indeterminate after an interrupted bootstrap.",
            });
          }
          yield* appendSetupScriptActivity({
            threadId,
            origin: options,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: requestedAt,
            payload: { idempotencyKey, worktreePath },
            tone: "info",
          });
        }
        yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "running"));
        const setupResult = yield* projectSetupScriptRunner
          .runForThread({
            threadId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
            worktreePath,
            ...(tracked
              ? {
                  observeCompletion: {
                    onOutputLine: (line) =>
                      worktreeSetupTracker.appendTail(threadId, "setup-script", line),
                  },
                }
              : {}),
          })
          .pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }).pipe(
                  Effect.andThen(
                    track(
                      worktreeSetupTracker.stageStatus(
                        threadId,
                        "setup-script",
                        "failed",
                        "failed to start",
                      ),
                    ),
                  ),
                  Effect.as(null),
                ),
              onSuccess: (setupResult) => {
                if (setupResult.status !== "started") {
                  const recordNoScript =
                    idempotencyKey === undefined
                      ? Effect.void
                      : appendSetupScriptActivity({
                          threadId,
                          origin: options,
                          kind: "setup-script.completed",
                          summary: "No setup script configured",
                          createdAt: requestedAt,
                          payload: { idempotencyKey, worktreePath },
                          tone: "info",
                        }).pipe(Effect.asVoid);
                  return recordNoScript.pipe(
                    Effect.andThen(
                      track(
                        worktreeSetupTracker.stageStatus(
                          threadId,
                          "setup-script",
                          "skipped",
                          "no setup script",
                        ),
                      ),
                    ),
                    Effect.as(null),
                  );
                }
                setupTerminalId = setupResult.terminalId;
                return recordSetupScriptStarted({
                  requestedAt,
                  worktreePath,
                  scriptId: setupResult.scriptId,
                  scriptName: setupResult.scriptName,
                  terminalId: setupResult.terminalId,
                }).pipe(
                  Effect.andThen(
                    track(
                      worktreeSetupTracker.update(threadId, (snapshot) => ({
                        ...snapshot,
                        setupScript: {
                          name: setupResult.scriptName,
                          command: setupResult.scriptCommand,
                          terminalId: setupResult.terminalId,
                        },
                      })),
                    ),
                  ),
                  Effect.as(setupResult),
                );
              },
            }),
          );
        if (!tracked || !setupResult?.completion) {
          return null;
        }
        // The setup script is best effort, like the untracked path: a failed
        // install must not throw away the worktree the user just waited for.
        // The card keeps the failed stage and its terminal. Forked right away
        // so the terminal listener behind `completion` is always consumed,
        // even when the turn dispatch fails before anyone would otherwise
        // wait on it. The tracker update is a no-op once the snapshot has
        // been dropped.
        const completionFiber = yield* setupResult.completion.pipe(
          Effect.flatMap((completion) => {
            if (completion.exitCode === 0) {
              return worktreeSetupTracker.stageStatus(threadId, "setup-script", "done");
            }
            const detail =
              completion.exitCode === null
                ? "terminal closed before the script finished"
                : `exit ${completion.exitCode}`;
            return worktreeSetupTracker.stageStatus(threadId, "setup-script", "failed", detail);
          }),
          Effect.forkDetach,
        );
        if (!setupResult.async) {
          yield* Fiber.join(completionFiber);
          return null;
        }
        return completionFiber;
      });

    const bootstrapProgram = Effect.gen(function* () {
      let shouldPrepareWorktree = prepareWorktree
        ? yield* gitWorkflow.isRepository(prepareWorktree.projectCwd)
        : false;
      let worktreeBaseRef = prepareWorktree?.baseBranch ?? null;
      // Crash recovery for deterministic branches: a retry reuses the
      // worktree its earlier attempt already checked out.
      const reusableWorktree =
        prepareWorktree &&
        shouldPrepareWorktree &&
        prepareWorktree.reuseExistingBranchWorktree === true &&
        prepareWorktree.branch !== undefined
          ? findReusableBranchWorktree(
              yield* gitWorkflow.listWorktrees({ cwd: prepareWorktree.projectCwd }),
              prepareWorktree.branch,
            )
          : undefined;

      if (prepareWorktree && reusableWorktree) {
        yield* track(
          worktreeSetupTracker.update(threadId, (snapshot) => ({
            ...snapshot,
            worktreePath: reusableWorktree.path,
            stages: snapshot.stages.map((stage) =>
              stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                ? { ...stage, status: "skipped", detail: "reusing existing worktree" }
                : stage,
            ),
          })),
        );
      } else if (prepareWorktree && shouldPrepareWorktree) {
        if (hasExplicitCheckout) {
          // Spawned sessions can pin a git ref or PR head. Resolving it may
          // fetch, so it reports as the fetch stage.
          const checkoutLabel =
            prepareWorktree.checkoutPr !== undefined
              ? `PR #${prepareWorktree.checkoutPr}`
              : (prepareWorktree.checkoutRef ?? prepareWorktree.baseBranch);
          yield* track(
            worktreeSetupTracker.stageStatus(threadId, "fetch", "running", checkoutLabel),
          );
          const checkoutCommit = yield* resolveWorktreeCheckoutCommit(gitWorkflow, {
            cwd: prepareWorktree.projectCwd,
            checkoutRef: prepareWorktree.checkoutRef ?? prepareWorktree.baseBranch,
            ...(prepareWorktree.checkoutPr !== undefined
              ? { checkoutPr: prepareWorktree.checkoutPr }
              : {}),
          });
          worktreeBaseRef = checkoutCommit.commitSha;
          yield* track(
            worktreeSetupTracker.stageStatus(
              threadId,
              "fetch",
              "done",
              `${checkoutLabel} at ${checkoutCommit.commitSha.slice(0, 7)}`,
            ),
          );
        } else {
          // "Start from origin" is a stored default; repos without the
          // requested remote branch fall back to the local base branch.
          const startFromOrigin =
            prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "running"));
            yield* gitWorkflow.fetchRemote({
              cwd: prepareWorktree.projectCwd,
              remoteName: "origin",
              refName: prepareWorktree.baseBranch,
            });
            const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
              cwd: prepareWorktree.projectCwd,
              refName: prepareWorktree.baseBranch,
              remoteName: "origin",
            });
            if (remoteBaseExists) {
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: prepareWorktree.projectCwd,
                refName: prepareWorktree.baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "done",
                  `origin/${prepareWorktree.baseBranch} at ${resolvedRemoteBase.commitSha.slice(0, 7)}`,
                ),
              );
            } else {
              yield* track(
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "fetch",
                  "warning",
                  `origin/${prepareWorktree.baseBranch} not found, using local branch`,
                ),
              );
            }
          } else {
            yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "skipped"));
          }

          const resolvedWorktreeBaseRef = worktreeBaseRef ?? prepareWorktree.baseBranch;
          shouldPrepareWorktree = yield* gitWorkflow.hasCommit({
            cwd: prepareWorktree.projectCwd,
            refName: resolvedWorktreeBaseRef,
          });
          worktreeBaseRef = resolvedWorktreeBaseRef;
        }
        const baseRef = worktreeBaseRef;
        yield* track(
          worktreeSetupTracker.update(threadId, (snapshot) => ({ ...snapshot, baseRef })),
        );
      }

      if (prepareWorktree && !shouldPrepareWorktree) {
        if (requireWorktree) {
          return yield* new OrchestrationDispatchCommandError({
            message:
              "A separate worktree requires a Git repository and a base branch with a commit.",
          });
        }
        // Not a git repo, or the base has no commit: the thread runs in the
        // project checkout instead. The card says so and moves on.
        yield* track(
          worktreeSetupTracker.update(threadId, (snapshot) => ({
            ...snapshot,
            stages: snapshot.stages.map((stage) =>
              stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                ? { ...stage, status: "skipped", detail: "using project checkout" }
                : stage,
            ),
          })),
        );
      }

      if (bootstrap?.createThread) {
        const created = yield* dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("bootstrap-thread-create"),
          threadId,
          projectId: bootstrap.createThread.projectId,
          title: bootstrap.createThread.title,
          modelSelection: bootstrap.createThread.modelSelection,
          runtimeMode: bootstrap.createThread.runtimeMode,
          interactionMode: bootstrap.createThread.interactionMode,
          branch: bootstrap.createThread.branch,
          worktreePath: bootstrap.createThread.worktreePath,
          spawnedByThreadId: bootstrap.createThread.spawnedByThreadId ?? null,
          reportDelivery: bootstrap.createThread.reportDelivery ?? null,
          createdAt: bootstrap.createThread.createdAt,
        });
        // The successful create is a fence in the engine command queue:
        // every delete for the prior incarnation committed before it. Drain
        // through that event before setup or turn start can own terminals
        // and provider sessions under the reused thread id.
        createdThread = true;
        yield* threadDeletionReactor.drainThrough(created.sequence);
        // Persist the send now rather than with the turn: the thread is real
        // from here on, so any client (or a reload) sees the message while
        // the worktree is still being prepared. The turn start later
        // references this id instead of re-sending the text. The append
        // command carries no message origin, so an agent-attributed message
        // is left for the turn start to persist with its attribution.
        if (command.message.origin === undefined) {
          yield* dispatch({
            type: "thread.message.user.append",
            commandId: yield* serverCommandId("bootstrap-thread-message"),
            threadId,
            message: {
              messageId: command.message.messageId,
              text: command.message.text,
              attachments: command.message.attachments,
              ...(command.message.context !== undefined
                ? { context: command.message.context }
                : {}),
            },
            createdAt: command.createdAt,
          });
        }
        if (tracked) {
          const running = yield* worktreeSetupTracker.get(threadId);
          if (running) yield* recordWorktreeSetup(running, options);
        }
      }

      if (prepareWorktree && reusableWorktree) {
        targetWorktreePath = reusableWorktree.path;
        yield* dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
          threadId,
          branch: prepareWorktree.branch,
          worktreePath: targetWorktreePath,
        });
        yield* refreshGitStatus(targetWorktreePath);
      } else if (prepareWorktree && shouldPrepareWorktree && worktreeBaseRef) {
        if (bootstrap?.createThread && createdThread) {
          // The checkout and setup script can run for minutes before the
          // turn starts, and the created thread carries no turn until then.
          // Project a starting session now so every client lists the thread
          // as working and a reopened thread knows to follow the setup
          // stream. A failed or cancelled setup deletes the thread, so
          // nothing lingers.
          const preparingAt = yield* nowIso;
          yield* dispatch({
            type: "thread.session.set",
            commandId: yield* serverCommandId("bootstrap-thread-preparing"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: null,
              providerInstanceId: bootstrap.createThread.modelSelection.instanceId,
              runtimeMode: command.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: preparingAt,
            },
            createdAt: preparingAt,
          });
          preparingSessionSet = true;
        }
        yield* track(worktreeSetupTracker.stageStatus(threadId, "checkout", "running"));
        let checkoutTotal: number | null = null;
        const submodules = yield* resolveBootstrapWorktreeSubmodules({
          threadId,
          projectId: targetProjectId ?? null,
        });
        const worktree = yield* gitWorkflow.createWorktree(
          {
            cwd: prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: prepareWorktree.branch,
            baseRefName: prepareWorktree.baseBranch,
            path: null,
          },
          {
            submodules,
            progress: {
              // Git has registered the directory at this point, so a cancel
              // during the submodule step can still remove it.
              onWorktreeClaimed: (path) =>
                Effect.sync(() => {
                  targetWorktreePath = path;
                  createdWorktreePath = path;
                }),
              onCheckoutProgress: ({ percent, completed, total }) => {
                checkoutTotal = total;
                return worktreeSetupTracker.stage(threadId, "checkout", {
                  percent,
                  detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                });
              },
              onSubmodulesStarted: () =>
                worktreeSetupTracker
                  .stageStatus(
                    threadId,
                    "checkout",
                    "done",
                    checkoutTotal === null
                      ? null
                      : `${checkoutTotal.toLocaleString("en-US")} files`,
                  )
                  .pipe(
                    Effect.andThen(
                      worktreeSetupTracker.stageStatus(threadId, "submodules", "running"),
                    ),
                  ),
              onSubmodulesDisabled: ({ source }) =>
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "submodules",
                  "skipped",
                  `disabled in ${source}`,
                ),
              onSubmoduleLine: (line) => {
                const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                return submodulePath === undefined
                  ? Effect.void
                  : worktreeSetupTracker.stage(threadId, "submodules", {
                      detail: submodulePath,
                    });
              },
              onSubmodulesFinished: ({ ok, detail }) =>
                worktreeSetupTracker.stageStatus(
                  threadId,
                  "submodules",
                  ok ? "done" : "warning",
                  ok ? undefined : (detail ?? "submodule checkout failed"),
                ),
            },
          },
        );
        const checkoutEndedAt = yield* nowIso;
        yield* track(
          worktreeSetupTracker.update(threadId, (snapshot) => ({
            ...snapshot,
            worktreePath: worktree.worktree.path,
            stages: snapshot.stages.map((stage) => {
              if (stage.id === "checkout" && stage.status === "running") {
                return {
                  ...stage,
                  status: "done",
                  percent: 100,
                  endedAt: checkoutEndedAt,
                  detail:
                    checkoutTotal === null
                      ? stage.detail
                      : `${checkoutTotal.toLocaleString("en-US")} files`,
                };
              }
              if (stage.id === "submodules" && stage.status === "pending") {
                return { ...stage, status: "skipped", detail: "none" };
              }
              return stage;
            }),
          })),
        );
        targetWorktreePath = worktree.worktree.path;
        createdWorktreePath = worktree.worktree.path;
        yield* dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
          threadId,
          branch: worktree.worktree.refName,
          worktreePath: targetWorktreePath,
        });
        yield* refreshGitStatus(targetWorktreePath);
      }

      const pendingSetupScript = yield* runSetupProgram();

      yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "running"));
      // Past this point a cancel would roll back a thread whose turn has
      // started. Drop the cancel handle and make the handoff atomic.
      yield* track(worktreeSetupTracker.markUncancellable(threadId));
      const started = yield* Effect.uninterruptible(dispatch(finalTurnStartCommand));
      yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "done"));
      // An async setup script outlives the handoff: the snapshot stays
      // running so the client keeps its row next to the agent's work, and
      // settles when the script exits. The turn already started, so the
      // wait cannot fail the dispatch.
      const settle = settleTracked("done");
      if (pendingSetupScript) {
        yield* Fiber.join(pendingSetupScript).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.andThen(settle),
          Effect.forkDetach,
        );
      } else {
        yield* settle;
      }
      return started;
    });

    const cleanupAndFail = (dispatchError: OrchestrationDispatchCommandError) =>
      Effect.uninterruptible(cleanupCreatedThread()).pipe(
        Effect.matchCauseEffect({
          onFailure: (cleanupCause) =>
            Effect.logWarning("bootstrap thread cleanup failed", {
              threadId,
              detail: Cause.pretty(cleanupCause),
            }).pipe(
              // The thread outlived its setup. Its preparing session must
              // not read as working forever, so record the failure on it.
              Effect.andThen(
                preparingSessionSet
                  ? markPreparingSessionFailed(dispatchError.message).pipe(
                      Effect.ignoreCause({ log: true }),
                    )
                  : Effect.void,
              ),
              Effect.flatMap(() => Effect.fail(dispatchError)),
            ),
          onSuccess: (threadDeleted) =>
            Effect.fail(
              threadDeleted || (bootstrap?.createThread && requireWorktree && !createdThread)
                ? new OrchestrationDispatchCommandError({
                    message: dispatchError.message,
                    ...(dispatchError.cause !== undefined ? { cause: dispatchError.cause } : {}),
                    bootstrapThreadDisposition: threadDeleted ? "deleted" : "not-created",
                  })
                : dispatchError,
            ),
        }),
      );

    const settledBootstrapProgram = bootstrapProgram.pipe(
      Effect.interruptible,
      Effect.catchCause((cause) => {
        const dispatchError = toBootstrapDispatchCommandCauseError(cause);
        if (!Cause.hasInterruptsOnly(cause)) {
          return settleTracked("failed", dispatchError.message).pipe(
            Effect.andThen(cleanupAndFail(dispatchError)),
          );
        }
        if (!tracked) {
          return Effect.fail(dispatchError);
        }
        // A user cancel interrupts the forked bootstrap fiber. The created
        // thread is rolled back like any other failure so the draft returns
        // to the composer. The setup terminal is closed first so a
        // still-running script cannot hold files open in the worktree while
        // git removes it. Closing kills the process asynchronously, so the
        // removal retries briefly.
        const closeSetupTerminal = setupTerminalId
          ? terminalManager.close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
          : Effect.void;
        const removeCreatedWorktree =
          createdWorktreePath && prepareWorktree
            ? closeSetupTerminal.pipe(
                Effect.ignoreCause({ log: true }),
                Effect.andThen(
                  gitWorkflow
                    .removeWorktree({
                      cwd: prepareWorktree.projectCwd,
                      path: createdWorktreePath,
                      force: true,
                    })
                    .pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") })),
                ),
                Effect.ignoreCause({ log: true }),
                Effect.uninterruptible,
              )
            : Effect.void;
        return settleTracked("cancelled").pipe(
          Effect.andThen(removeCreatedWorktree),
          Effect.andThen(
            cleanupAndFail(
              new OrchestrationDispatchCommandError({ message: "Worktree setup cancelled." }),
            ),
          ),
        );
      }),
      // Cancellation must finish recording and rollback after the bootstrap
      // is interrupted.
      Effect.uninterruptible,
    );

    if (!tracked) {
      return yield* settledBootstrapProgram;
    }
    // A worktree bootstrap outlives the connection that asked for it: a
    // reload or a dropped socket must not abandon a half-made worktree, and
    // the thread it created is already visible to every client. The caller
    // only waits on the detached fiber; a user cancel interrupts it through
    // the tracker. Fork and register as one step: a detached fiber keeps
    // going if the caller is interrupted, so it must never exist without the
    // tracker entry that cancel and the stage updates key on.
    const fiber = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkDetach(settledBootstrapProgram);
        yield* worktreeSetupTracker.begin({
          threadId,
          branch: prepareWorktree?.branch ?? null,
          baseRef: prepareWorktree?.baseBranch ?? null,
          stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
          fiber,
        });
        return fiber;
      }),
    );
    return yield* Fiber.join(fiber);
  });

  const cleanupRecoveredThread: ThreadTurnBootstrap["Service"]["cleanupRecoveredThread"] =
    Effect.fn("ThreadTurnBootstrap.cleanupRecoveredThread")(function* (threadId) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.delete",
          commandId: yield* serverCommandId("recovered-bootstrap-thread-delete"),
          threadId,
        })
        .pipe(
          Effect.catchCause((cause) => Effect.fail(toBootstrapDispatchCommandCauseError(cause))),
        );
    });

  return ThreadTurnBootstrap.of({ bootstrapTurnStart, cleanupRecoveredThread });
});

export const layer = Layer.effect(ThreadTurnBootstrap, make);
