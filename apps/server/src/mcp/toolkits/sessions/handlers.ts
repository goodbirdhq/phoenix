import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type PostReportInput,
  type ReadSessionResult,
  type RuntimeMode,
  SESSION_SPAWN_MAX_CHILDREN,
  SESSION_SPAWN_MAX_DEPTH,
  SessionOrchestrationDeniedError,
  SessionOrchestrationInvalidInputError,
  SessionOrchestrationOperationError,
  SessionOrchestrationUnavailableError,
  type ServerProvider,
  type SpawnSessionInput,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SessionsToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// full-access at the top so a child can never be granted more than the
// thread that spawned it.
const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

const operationError = (message: string) => (cause: unknown) =>
  new SessionOrchestrationOperationError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const truncateText = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

type SpawnCheckoutInput = Pick<
  SpawnSessionInput,
  "isolation" | "gitRef" | "baseRef" | "branchName" | "checkoutPr"
>;

// Kept separate from the handler's service graph so the invalid combinations
// stay easy to audit and cannot start a thread before they are rejected.
export const validateSpawnCheckoutInput = (
  input: SpawnCheckoutInput,
  isGitRepository: boolean,
): string | null => {
  if (input.checkoutPr !== undefined && input.gitRef !== undefined) {
    return "checkoutPr cannot be combined with gitRef; choose either a pull request or a git ref.";
  }
  const requestedCheckout =
    input.gitRef !== undefined ||
    input.baseRef !== undefined ||
    input.branchName !== undefined ||
    input.checkoutPr !== undefined;
  if (requestedCheckout && input.isolation === "project-root") {
    return 'gitRef, baseRef, branchName, and checkoutPr require isolation: "worktree".';
  }
  if (requestedCheckout && !isGitRepository) {
    return "A git checkout was requested, but this project is not a git repository with a current branch.";
  }
  return null;
};

// Appended to every spawned session's first message so the completion
// contract holds across providers without the parent having to remember to
// ask for it. post_report is what wakes the parent up.
const SPAWNED_SESSION_REPORT_INSTRUCTIONS =
  "\n\n---\nYou were spawned by another Phoenix agent session to do the work above. When the work is complete — or you determine it cannot be completed — call the `post_report` tool exactly once with status (success/failure/partial), a concise markdown summary of what you did, and any artifacts (files, branches, PR URLs). The report is delivered to the session that spawned you.";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const bootstrap = yield* ThreadTurnBootstrap.ThreadTurnBootstrap;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  // Read per call rather than at layer build so flipping the setting takes
  // effect for already-running sessions on their next tool call.
  const requireSessionsCapability = Effect.gen(function* () {
    const invocationScope = yield* McpInvocationContext.requireMcpSessionsCapability();
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(operationError("Failed to read server settings")),
    );
    if (!settings.enableSessionOrchestration) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "disabled_in_settings",
        message:
          "Session orchestration is disabled in this environment's settings (Settings → Session orchestration).",
      });
    }
    return invocationScope;
  });

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(operationError("Failed to generate identifier")),
  );
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const enqueue = <A, E>(effect: Effect.Effect<A, E>) =>
    startup
      .enqueueCommand(effect)
      .pipe(Effect.mapError(operationError("Failed to dispatch orchestration command")));

  const getShell = (threadId: ThreadId) =>
    snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(operationError("Failed to read thread state")));

  const requireShell = (threadId: ThreadId) =>
    getShell(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SessionOrchestrationInvalidInputError({
                message: `Thread ${threadId} was not found or is archived.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  // Every mutating tool operates only on direct children of the calling
  // thread; a session cannot reach siblings, parents, or the user's other
  // threads through this toolkit.
  const requireSpawnedChild = (parentThreadId: ThreadId, threadId: ThreadId) =>
    requireShell(threadId).pipe(
      Effect.flatMap((shell) =>
        (shell.spawnedByThreadId ?? null) === parentThreadId
          ? Effect.succeed(shell)
          : Effect.fail(
              new SessionOrchestrationDeniedError({
                reason: "not_spawned_by_this_session",
                message: `Thread ${threadId} was not spawned by this session.`,
              }),
            ),
      ),
    );

  const resolveSpawnDepth = (parent: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      let depth = 1;
      let cursor = parent.spawnedByThreadId ?? null;
      while (cursor !== null && depth <= SESSION_SPAWN_MAX_DEPTH) {
        depth += 1;
        const shell = yield* getShell(ThreadId.make(cursor));
        cursor = Option.isSome(shell) ? (shell.value.spawnedByThreadId ?? null) : null;
      }
      return depth;
    });

  const resolveProvider = (
    providers: ReadonlyArray<ServerProvider>,
    instanceId: string,
  ): ServerProvider | undefined => providers.find((provider) => provider.instanceId === instanceId);

  const listProviders = Effect.fn("SessionsToolkit.listProviders")(function* (input: {
    readonly onlyAvailable?: boolean | undefined;
  }) {
    yield* requireSessionsCapability;
    const allProviders = yield* providerRegistry.getProviders.pipe(
      Effect.mapError(operationError("Failed to read provider registry")),
    );
    const providers =
      input.onlyAvailable === true ? allProviders.filter(isProviderAvailable) : allProviders;
    return {
      providers: providers.map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName ?? provider.driver,
        available: isProviderAvailable(provider),
        models: provider.models.map((model) => ({
          id: model.slug,
          displayName: model.name,
          isDefault: model.isDefault === true,
          ...(model.capabilities?.optionDescriptors
            ? { options: model.capabilities.optionDescriptors }
            : {}),
        })),
      })),
    };
  });

  const spawnSession = Effect.fn("SessionsToolkit.spawnSession")(function* (
    input: SpawnSessionInput,
  ) {
    const scope = yield* requireSessionsCapability;
    const parent = yield* requireShell(scope.threadId);

    const depth = yield* resolveSpawnDepth(parent);
    if (depth >= SESSION_SPAWN_MAX_DEPTH) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "spawn_depth_exceeded",
        message: `Spawn chains are limited to ${SESSION_SPAWN_MAX_DEPTH} levels.`,
      });
    }

    const shellSnapshot = yield* snapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError(operationError("Failed to read thread snapshot")));
    const childCount = shellSnapshot.threads.filter(
      (thread) => (thread.spawnedByThreadId ?? null) === scope.threadId,
    ).length;
    if (childCount >= SESSION_SPAWN_MAX_CHILDREN) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "spawn_limit_reached",
        message: `This session already has ${childCount} spawned sessions (stopping one does not free a slot — it stays counted until archived). Archive a spawned thread from the sidebar first.`,
      });
    }

    const runtimeMode = input.runtimeMode ?? parent.runtimeMode;
    if (RUNTIME_MODE_RANK[runtimeMode] > RUNTIME_MODE_RANK[parent.runtimeMode]) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "runtime_mode_exceeds_parent",
        message: `Requested runtime mode "${runtimeMode}" exceeds this session's own "${parent.runtimeMode}".`,
      });
    }

    const projectId = input.projectId ?? parent.projectId;
    const project = yield* snapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.mapError(operationError("Failed to read project")));
    if (Option.isNone(project)) {
      return yield* new SessionOrchestrationInvalidInputError({
        message: `Project ${projectId} was not found.`,
      });
    }
    const workspaceRoot = project.value.workspaceRoot;

    const providers = yield* providerRegistry.getProviders.pipe(
      Effect.mapError(operationError("Failed to read provider registry")),
    );
    const instanceId = input.providerInstanceId ?? parent.modelSelection.instanceId;
    const provider = resolveProvider(providers, instanceId);
    if (!provider) {
      return yield* new SessionOrchestrationInvalidInputError({
        message: `Provider instance "${instanceId}" was not found. Call list_session_providers for valid choices.`,
      });
    }
    if (!isProviderAvailable(provider)) {
      return yield* new SessionOrchestrationUnavailableError({
        message: `Provider instance "${instanceId}" is not available (not installed, disabled, or unauthenticated).`,
      });
    }
    const model =
      input.model ??
      provider.models.find((entry) => entry.isDefault === true)?.slug ??
      provider.models[0]?.slug;
    if (model === undefined) {
      return yield* new SessionOrchestrationUnavailableError({
        message: `Provider instance "${instanceId}" reports no models.`,
      });
    }
    if (input.model !== undefined && !provider.models.some((entry) => entry.slug === input.model)) {
      return yield* new SessionOrchestrationInvalidInputError({
        message: `Model "${input.model}" is not offered by provider instance "${instanceId}".`,
      });
    }
    if (input.options !== undefined) {
      const descriptors =
        provider.models.find((entry) => entry.slug === model)?.capabilities?.optionDescriptors ??
        [];
      for (const selection of input.options) {
        const descriptor = descriptors.find((entry) => entry.id === selection.id);
        if (!descriptor) {
          return yield* new SessionOrchestrationInvalidInputError({
            message: `Model "${model}" has no option "${selection.id}". Valid options: ${
              descriptors.map((entry) => entry.id).join(", ") || "none"
            }.`,
          });
        }
        if (descriptor.type === "select") {
          if (
            typeof selection.value !== "string" ||
            !descriptor.options.some((choice) => choice.id === selection.value)
          ) {
            return yield* new SessionOrchestrationInvalidInputError({
              message: `Option "${selection.id}" accepts: ${descriptor.options
                .map((choice) => choice.id)
                .join(", ")}.`,
            });
          }
        } else if (typeof selection.value !== "boolean") {
          return yield* new SessionOrchestrationInvalidInputError({
            message: `Option "${selection.id}" is a boolean.`,
          });
        }
      }
    }
    const modelSelection: ModelSelection = {
      instanceId: provider.instanceId,
      model,
      ...(input.options !== undefined ? { options: input.options } : {}),
    };

    // Worktree isolation is the default, but only meaningful inside a git
    // repository; a non-repo project falls back to sharing the project root
    // unless the caller explicitly demanded a worktree.
    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: workspaceRoot })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const repoBranch = localStatus?.isRepo === true ? (localStatus.refName ?? null) : null;
    const requestedIsolation = input.isolation ?? "worktree";
    const checkoutValidationError = validateSpawnCheckoutInput(input, repoBranch !== null);
    if (checkoutValidationError !== null) {
      return yield* new SessionOrchestrationInvalidInputError({ message: checkoutValidationError });
    }
    if (
      requestedIsolation === "worktree" &&
      repoBranch === null &&
      input.isolation === "worktree"
    ) {
      return yield* new SessionOrchestrationInvalidInputError({
        message: `Project ${projectId} is not a git repository with a current branch; use isolation: "project-root".`,
      });
    }
    const useWorktree = requestedIsolation === "worktree" && repoBranch !== null;

    const createdAt = yield* nowIso;
    const threadId = ThreadId.make(yield* randomUUID);
    const messageId = MessageId.make(yield* randomUUID);
    const worktreeBranchToken = (yield* randomUUID).replace(/-/g, "");
    const commandId = yield* serverCommandId("mcp-spawn-session");
    const title = input.title ?? truncateText(input.prompt.replace(/\s+/g, " ").trim(), 80);
    const interactionMode = input.interactionMode ?? "default";

    yield* enqueue(
      bootstrap.bootstrapTurnStart({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: `${input.prompt}${SPAWNED_SESSION_REPORT_INSTRUCTIONS}`,
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            spawnedByThreadId: scope.threadId,
            createdAt,
          },
          ...(useWorktree
            ? {
                prepareWorktree: {
                  projectCwd: workspaceRoot,
                  baseBranch: input.baseRef ?? repoBranch,
                  ...(input.gitRef !== undefined ? { checkoutRef: input.gitRef } : {}),
                  ...(input.checkoutPr !== undefined ? { checkoutPr: input.checkoutPr } : {}),
                  // Without a fresh branch name, `git worktree add` would try
                  // to check out the base branch a second time and fail.
                  branch:
                    input.branchName ?? buildTemporaryWorktreeBranchName(() => worktreeBranchToken),
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt,
      }),
    );

    const spawned = yield* requireShell(threadId);
    const worktreePath = spawned.worktreePath ? NodePath.resolve(spawned.worktreePath) : null;
    const checkout = yield* worktreePath
      ? Effect.all({
          status: gitWorkflow.localStatus({ cwd: worktreePath }),
          commit: gitWorkflow.resolveCommit({ cwd: worktreePath, revision: "HEAD" }),
        }).pipe(Effect.mapError(operationError("Failed to resolve spawned session checkout")))
      : Effect.succeed(null);
    return {
      threadId,
      title: spawned.title,
      projectId: spawned.projectId,
      modelSelection: spawned.modelSelection,
      runtimeMode: spawned.runtimeMode,
      branch: checkout?.status.refName ?? spawned.branch,
      worktreePath,
      sha: checkout?.commit.commitSha ?? null,
      dirty: checkout?.status.hasWorkingTreeChanges ?? null,
    };
  });

  const sendToSession = Effect.fn("SessionsToolkit.sendToSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly message: string;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    const createdAt = yield* nowIso;
    yield* enqueue(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("mcp-send-to-session"),
        threadId: child.id,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text: input.message,
          attachments: [],
        },
        runtimeMode: child.runtimeMode,
        interactionMode: child.interactionMode,
        createdAt,
      }),
    );
    return { threadId: child.id };
  });

  const readSession = Effect.fn("SessionsToolkit.readSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageLimit?: number | undefined;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    const messageLimit = input.messageLimit ?? 5;
    let messages: ReadSessionResult["messages"] = [];
    let report: ReadSessionResult["report"] = null;
    const detail = yield* snapshotQuery
      .getThreadDetailById(child.id)
      .pipe(Effect.mapError(operationError("Failed to read thread detail")));
    if (Option.isSome(detail)) {
      report = detail.value.reports.at(-1) ?? null;
      if (messageLimit > 0) {
        messages = detail.value.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-messageLimit)
          .map((message) => ({
            role: message.role === "user" ? ("user" as const) : ("assistant" as const),
            text: truncateText(message.text, 16_384),
            createdAt: message.createdAt,
          }));
      }
    }
    const worktreePath = child.worktreePath ? NodePath.resolve(child.worktreePath) : null;
    if (worktreePath) {
      yield* gitWorkflow.invalidateLocalStatus(worktreePath);
    }
    const checkout = yield* worktreePath
      ? Effect.all({
          status: gitWorkflow.localStatus({ cwd: worktreePath }),
          commit: gitWorkflow.resolveCommit({ cwd: worktreePath, revision: "HEAD" }),
        }).pipe(Effect.mapError(operationError("Failed to resolve session checkout")))
      : Effect.succeed(null);
    return {
      threadId: child.id,
      title: child.title,
      sessionStatus: child.session?.status ?? null,
      settled: child.settledAt !== null,
      report,
      messages,
      ...(checkout
        ? {
            branch: checkout.status.refName ?? child.branch,
            worktreePath,
            sha: checkout.commit.commitSha,
            dirty: checkout.status.hasWorkingTreeChanges,
          }
        : {}),
    };
  });

  const postReport = Effect.fn("SessionsToolkit.postReport")(function* (input: PostReportInput) {
    const scope = yield* requireSessionsCapability;
    yield* requireShell(scope.threadId);
    const createdAt = yield* nowIso;
    const reportId = yield* randomUUID;
    yield* enqueue(
      engine.dispatch({
        type: "thread.report.post",
        commandId: yield* serverCommandId("mcp-post-report"),
        threadId: scope.threadId,
        reportId,
        status: input.status,
        title: input.title,
        summary: input.summary,
        artifacts: input.artifacts ?? [],
        ...(input.findings !== undefined ? { findings: input.findings } : {}),
        ...(input.validation !== undefined ? { validation: input.validation } : {}),
        ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
        ...(input.completionPercent !== undefined
          ? { completionPercent: input.completionPercent }
          : {}),
        createdAt,
      }),
    );
    return {
      reportId,
      threadId: scope.threadId,
      status: input.status,
      title: input.title,
      summary: input.summary,
      artifacts: input.artifacts ?? [],
      ...(input.findings !== undefined ? { findings: input.findings } : {}),
      ...(input.validation !== undefined ? { validation: input.validation } : {}),
      ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
      ...(input.completionPercent !== undefined
        ? { completionPercent: input.completionPercent }
        : {}),
      createdAt,
    };
  });

  const stopSession = Effect.fn("SessionsToolkit.stopSession")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    yield* enqueue(
      engine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("mcp-stop-session"),
        threadId: child.id,
        createdAt: yield* nowIso,
      }),
    );
    return { threadId: child.id, status: "stop-requested" as const };
  });

  return {
    list_session_providers: (input) => listProviders(input ?? {}),
    spawn_session: (input) => spawnSession(input),
    send_to_session: (input) => sendToSession(input),
    read_session: (input) => readSession(input),
    stop_session: (input) => stopSession(input),
    post_report: (input) => postReport(input),
  } satisfies Parameters<typeof SessionsToolkit.toLayer>[0];
});

export const SessionsToolkitHandlersLive = SessionsToolkit.toLayer(make);
