import {
  checkReportSupersession,
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  type PingSessionResult,
  type PostReportInput,
  READ_REPORT_MAX_CHARS,
  type ReadReportInput,
  type ReadSessionResult,
  reportAlreadySupersededMessage,
  type RuntimeMode,
  SESSION_SPAWN_MAX_CHILDREN,
  SESSION_SPAWN_MAX_DEPTH,
  SessionOrchestrationBranchNotMergedError,
  SessionOrchestrationDeniedError,
  SessionOrchestrationGitLockError,
  SessionOrchestrationInvalidInputError,
  SessionOrchestrationOperationError,
  SessionOrchestrationReportAlreadySupersededError,
  SessionOrchestrationUnavailableError,
  SessionOrchestrationWorktreeNotEmptyError,
  type ServerProvider,
  type SessionUsageSnapshot,
  supersededReportNotice,
  type SettleSessionInput,
  type SettleSessionWorktreeOutcome,
  type SpawnSessionInput,
  ThreadId,
  toSessionReportEnvelope,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as GitRepositoryLock from "../../../git/GitRepositoryLock.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveSessionUsageSnapshot } from "../../../orchestration/sessionUsage.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import {
  type ProjectionThreadReport,
  ProjectionThreadReportRepository,
} from "../../../persistence/Services/ProjectionThreadReports.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
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

type SessionCheckoutGitWorkflow = Pick<
  GitWorkflowService.GitWorkflowService["Service"],
  "localStatus" | "resolveCommit"
>;

export const resolveSessionCheckout = (gitWorkflow: SessionCheckoutGitWorkflow, cwd: string) =>
  Effect.all({
    status: gitWorkflow.localStatus({ cwd }),
    commit: gitWorkflow.resolveCommit({ cwd, revision: "HEAD" }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logDebug("spawned session checkout metadata unavailable", { cwd, error }).pipe(
        Effect.as(null),
      ),
    ),
  );

export const resolveSendToSessionDelivery = (eventType: string | undefined) => {
  if (eventType === "thread.turn-start-queued") return Effect.succeed("queued" as const);
  if (eventType === "thread.turn-start-requested") return Effect.succeed("immediate" as const);
  return Effect.succeed("unknown" as const);
};

// Who may read a thread's reports through read_report: the thread itself,
// the session that spawned it, and its siblings (threads spawned by the same
// parent). Sibling reads are the deliberate exception to the children-only
// rule — they let one spawned session review another's report without the
// parent relaying up to 16KB of markdown by hand.
export const canReadThreadReports = (input: {
  readonly callerThreadId: string;
  readonly callerSpawnedByThreadId: string | null;
  readonly targetThreadId: string;
  readonly targetSpawnedByThreadId: string | null;
}): boolean =>
  input.targetThreadId === input.callerThreadId ||
  input.targetSpawnedByThreadId === input.callerThreadId ||
  (input.callerSpawnedByThreadId !== null &&
    input.targetSpawnedByThreadId === input.callerSpawnedByThreadId);

// One constant denial for every unreadable-report case (unknown id, foreign
// thread, archived thread, id/thread mismatch, no report posted yet), so
// responses cannot be used to probe which reports or threads exist.
export const REPORT_NOT_ACCESSIBLE_MESSAGE =
  "Report not accessible: it does not exist, has not been posted yet, or belongs to a session outside this session's read scope (own spawned sessions and their siblings).";

// One message for both ways a supersedesReportId can fail to resolve — no
// such report, or a report on another thread. Amending another session's
// report is not a weaker version of amending your own: a report is a
// session's account of its own work, so only the thread that posted one may
// replace it. Saying which of the two went wrong would also turn post_report
// into a probe for which report ids exist elsewhere.
export const SUPERSEDES_REPORT_NOT_FOUND_MESSAGE =
  "supersedesReportId does not name a report posted by this session. Pass the reportId returned by your own earlier post_report call on this thread; a report can only be amended by the session that posted it.";

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Pure pagination over a report summary, in UTF-16 code units (the same
// units as `summary.length`). Offsets past the end return an empty body
// rather than failing, so callers can walk pages blindly. Boundaries are
// adjusted so a surrogate pair is never split: a start landing on the low
// half backs up to include the whole character (reflected in the returned
// `offset`), and an end that would split a pair leaves it for the next page
// (or, when maxChars is too small to hold the pair, extends by one unit so
// paging always makes progress).
export const sliceReportBody = (
  summary: string,
  options: { readonly offset?: number | undefined; readonly maxChars?: number | undefined },
): { body: string; offset: number; totalChars: number; hasMore: boolean } => {
  const totalChars = summary.length;
  let start = Math.min(options.offset ?? 0, totalChars);
  if (
    start > 0 &&
    start < totalChars &&
    isLowSurrogate(summary.charCodeAt(start)) &&
    isHighSurrogate(summary.charCodeAt(start - 1))
  ) {
    start -= 1;
  }
  const maxChars = options.maxChars ?? READ_REPORT_MAX_CHARS;
  let end = Math.min(start + maxChars, totalChars);
  if (
    end > start &&
    end < totalChars &&
    isHighSurrogate(summary.charCodeAt(end - 1)) &&
    isLowSurrogate(summary.charCodeAt(end))
  ) {
    end = end - 1 > start ? end - 1 : end + 1;
  }
  const body = summary.slice(start, end);
  return { body, offset: start, totalChars, hasMore: end < totalChars };
};

// Pure so it's cheap to unit test independent of the Effect layers: builds
// the ping_session response from data already resolved by the caller (the
// child's shell, and its hasReport/lastAssistantMessage from purpose-built,
// turn-independent queries — not a turn-windowed detail read, so this never
// has to reconcile "which turn" the snippet came from).
export const buildPingSessionSnapshot = (input: {
  readonly shell: OrchestrationThreadShell;
  readonly lastActivityAt: string | null;
  readonly hasReport: boolean;
  readonly lastAssistantMessage: string | null;
  readonly usage: SessionUsageSnapshot;
}): Omit<PingSessionResult, "threadId"> => ({
  sessionStatus: input.shell.session?.status ?? null,
  settled: input.shell.settledAt !== null,
  lastActivityAt: input.lastActivityAt,
  currentActivity: input.shell.backgroundLiveness ?? null,
  planProgress: input.shell.planProgress ?? null,
  hasReport: input.hasReport,
  lastAssistantMessage:
    input.lastAssistantMessage !== null ? truncateText(input.lastAssistantMessage, 500) : null,
  usage: input.usage,
});

// Appended to every spawned session's first message so the completion
// contract holds across providers without the parent having to remember to
// ask for it. post_report is what wakes the parent up.
const SPAWNED_SESSION_REPORT_INSTRUCTIONS =
  "\n\n---\nYou were spawned by another Phoenix agent session to do the work above. When the work is complete — or you determine it cannot be completed — call the `post_report` tool exactly once with status (success/failure/partial), a concise markdown summary of what you did, and any artifacts (files, branches, PR URLs). If the summary is long, also pass a 1-3 sentence `abstract`. The report is delivered to the session that spawned you.\n\nIf you receive a further instruction AFTER you have already posted your report, do the new work and then post an AMENDING report: call `post_report` again with `supersedesReportId` set to the reportId of the report you are replacing. The amended report becomes the record. Never claim in a report that you did something you had not yet done when that report was written — describe what the late instruction was and what you did about it.";

// Enough to tell the caller what is at stake without turning a refusal into a
// transcript of a large working tree.
const MAX_REPORTED_DIRTY_FILES = 20;

// How long settle_session waits for a stopped provider process to actually be
// gone before it declines to delete anything. Generous enough for a normal
// shutdown, short enough that an agent is not left hanging on a wedged one.
const SESSION_STOP_TIMEOUT_MS = 10_000;
const SESSION_STOP_POLL_INTERVAL_MS = 100;

/**
 * Whether a turn is actively in flight.
 *
 * Mirrors the decider's settle guard (`decider.ts`): these two statuses are
 * exactly what makes `thread.settle` fail, so settle_session can refuse first
 * with an actionable message instead of surfacing a raw invariant error.
 * Live work is never interrupted on the parent's say-so.
 */
export function isSessionBusy(status: OrchestrationSessionStatus | null | undefined): boolean {
  return status === "starting" || status === "running";
}

/**
 * Whether a provider process is still up.
 *
 * "ready" is idle but alive — the process is sitting there resumable. Settling
 * such a child without stopping it would leak the process, and deleting its
 * worktree underneath it would race a `send_to_session` that revives it. So
 * settle_session stops anything alive before it settles or touches the disk.
 */
export function isSessionAlive(status: OrchestrationSessionStatus | null | undefined): boolean {
  return status !== null && status !== undefined && status !== "stopped";
}

export interface WorktreeCleanupRisk {
  readonly dirtyFiles: ReadonlyArray<string>;
  readonly dirtyFileCount: number;
  readonly unpushedCommitCount: number;
  readonly hasUpstream: boolean;
  readonly hasUnsavedWork: boolean;
}

/**
 * Decide whether deleting a worktree would destroy work.
 *
 * "Saved" means committed AND reachable from somewhere other than this
 * worktree's branch. With an upstream, `aheadCount` is what has not been
 * pushed; without one, every commit past the default branch exists only here,
 * which is what `aheadOfDefaultCount` measures.
 */
export function assessWorktreeCleanupRisk(
  status: Pick<
    VcsStatusResult,
    "workingTree" | "hasUpstream" | "aheadCount" | "aheadOfDefaultCount"
  >,
): WorktreeCleanupRisk {
  const dirtyFiles = status.workingTree.files.map((file) => file.path);
  const unpushedCommitCount = status.hasUpstream
    ? status.aheadCount
    : (status.aheadOfDefaultCount ?? 0);
  return {
    dirtyFiles: dirtyFiles.slice(0, MAX_REPORTED_DIRTY_FILES),
    dirtyFileCount: dirtyFiles.length,
    unpushedCommitCount,
    hasUpstream: status.hasUpstream,
    hasUnsavedWork: dirtyFiles.length > 0 || unpushedCommitCount > 0,
  };
}

/**
 * Decide whether settle_session may delete the child's branch.
 *
 * Only the throwaway `t3code/…` branches Phoenix creates for worktree
 * isolation are ours to delete on sight. A branch the user named is deleted
 * only when the caller asked for it (`cleanupBranch`) *and* the merge proof
 * below holds; otherwise it is preserved and reported.
 */
export function decideBranchCleanup(
  branch: string | null,
  options: { readonly cleanupBranch?: boolean | undefined } = {},
): {
  readonly deleteBranch: boolean;
  readonly requiresMergeProof: boolean;
  readonly detail: string | null;
} {
  if (branch === null) {
    return { deleteBranch: false, requiresMergeProof: false, detail: null };
  }
  if (isTemporaryWorktreeBranch(branch)) {
    return { deleteBranch: true, requiresMergeProof: false, detail: null };
  }
  if (options.cleanupBranch === true) {
    return { deleteBranch: true, requiresMergeProof: true, detail: null };
  }
  return {
    deleteBranch: false,
    requiresMergeProof: false,
    detail: `Kept branch "${branch}": it is not a Phoenix temporary worktree branch, so it may hold work you still want. Pass cleanupBranch: true to delete it once Phoenix can prove it was merged.`,
  };
}

// A lock file younger than this is assumed to belong to a git process that is
// still working. Generous: our own git commands time out at 15s, so anything
// older than a minute outlived every command Phoenix could have started.
export const GIT_LOCK_STALE_AFTER_MS = 60_000;

/**
 * Pull the lock file path out of a git failure.
 *
 * Both shapes git uses name the file in single quotes:
 *   "fatal: Unable to create '/repo/.git/index.lock': File exists."
 *   "error: cannot lock ref 'refs/heads/x': Unable to create '/repo/.git/refs/heads/x.lock': File exists"
 * Returns null for any other failure, which is what keeps ordinary git errors
 * out of the lock-specific error path.
 */
export function parseGitLockPath(message: string): string | null {
  if (!/unable to create/i.test(message) || !/file exists/i.test(message)) {
    return null;
  }
  const match = /'([^']*\.lock)'/.exec(message);
  return match?.[1] ?? null;
}

/**
 * Conservative staleness heuristic for a leftover git lock.
 *
 * A lock looks abandoned when it is BOTH zero bytes — git writes the new index
 * or ref into the lock file, so an empty one means the writer died before it
 * wrote anything — AND older than {@link GIT_LOCK_STALE_AFTER_MS}.
 *
 * "Looks" is as far as this goes: nothing here can prove that no live git
 * process on the machine owns the lock (a developer's shell, a second Phoenix,
 * an editor's git integration), and deleting a live lock corrupts the index.
 * So the caller reports the path and the remedy instead of deleting it.
 */
export function assessGitLockStaleness(stat: {
  readonly sizeBytes: number | null;
  readonly ageMs: number | null;
}): { readonly appearsStale: boolean; readonly detail: string } {
  if (stat.ageMs === null) {
    return {
      appearsStale: false,
      detail: "the lock file could not be inspected (it may have just been released)",
    };
  }
  const ageSeconds = Math.round(stat.ageMs / 1000);
  if (stat.sizeBytes !== 0) {
    return { appearsStale: false, detail: `it is ${ageSeconds}s old and not empty` };
  }
  if (stat.ageMs < GIT_LOCK_STALE_AFTER_MS) {
    return {
      appearsStale: false,
      detail: `it is empty but only ${ageSeconds}s old, so a git process is probably still writing`,
    };
  }
  return {
    appearsStale: true,
    detail: `it is empty and ${ageSeconds}s old, which matches a git process that died mid-write`,
  };
}

// Exported so tests can drive the real handlers against stub services; the
// wiring between them (stop → settle → cleanup ordering) is exactly what pure
// helper tests cannot see.
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const bootstrap = yield* ThreadTurnBootstrap.ThreadTurnBootstrap;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const reportRepository = yield* ProjectionThreadReportRepository;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const repositoryLock = yield* GitRepositoryLock.GitRepositoryLock;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

  // The provider session directory tracks activity for every session this
  // server runs, keyed by thread; there is no by-thread lookup with the
  // lastSeenAt metadata, so scan the (small) live binding list. Follow-up:
  // a dedicated by-thread lookup would avoid this scan if the binding list
  // ever stops being small.
  //
  // Best-effort: this is optional enrichment on a read path (read_session,
  // ping_session), so a directory failure must never keep the caller from
  // seeing the child's shell-derived status.
  const getLastActivityAt = (threadId: ThreadId) =>
    providerSessionDirectory.listBindings().pipe(
      Effect.map(
        (bindings) => bindings.find((binding) => binding.threadId === threadId)?.lastSeenAt ?? null,
      ),
      Effect.catch(() => Effect.succeed(null)),
    );

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
  // threads through this toolkit. (read_report is the one read-only
  // exception: it also accepts sibling threads — see canReadThreadReports.)
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
      .pipe(Effect.orElseSucceed(() => null));
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
    const worktreePath = spawned.worktreePath ? path.resolve(spawned.worktreePath) : null;
    const checkout = yield* worktreePath
      ? resolveSessionCheckout(gitWorkflow, worktreePath)
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
    readonly mode?: "queue" | "interrupt" | undefined;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    const createdAt = yield* nowIso;
    const result = yield* enqueue(
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
        ...(input.mode !== undefined ? { deliveryMode: input.mode } : {}),
        createdAt,
      }),
    );
    const acknowledgedEvent = yield* engine.readEvents(result.sequence - 1, 1).pipe(
      Stream.runHead,
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    const delivery = yield* resolveSendToSessionDelivery(
      Option.isSome(acknowledgedEvent) ? acknowledgedEvent.value.type : undefined,
    );
    return {
      threadId: child.id,
      delivery,
    };
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
      const latest = detail.value.reports.at(-1);
      report = latest === undefined ? null : toSessionReportEnvelope(latest);
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
    const worktreePath = child.worktreePath ? path.resolve(child.worktreePath) : null;
    const checkout = yield* worktreePath
      ? resolveSessionCheckout(gitWorkflow, worktreePath)
      : Effect.succeed(null);
    const lastActivityAt = yield* getLastActivityAt(child.id);
    return {
      threadId: child.id,
      title: child.title,
      sessionStatus: child.session?.status ?? null,
      settled: child.settledAt !== null,
      lastActivityAt,
      currentActivity: child.backgroundLiveness ?? null,
      // Null once settle_session reclaimed the worktree; a path means the
      // directory is still on disk and nothing else will clean it up.
      worktreePath: child.worktreePath,
      branch: child.branch,
      report,
      stoppedBy: child.session?.stoppedBy ?? null,
      stopRequestedAt: child.session?.stopRequestedAt ?? null,
      stopReason: child.session?.stopReason ?? null,
      interruptedToolCall: child.session?.interruptedToolCall ?? false,
      lastCompletedOperation: child.session?.lastCompletedOperation ?? null,
      messages,
      ...(worktreePath
        ? {
            branch: checkout?.status.refName ?? child.branch,
            worktreePath,
            sha: checkout?.commit.commitSha ?? null,
            dirty: checkout?.status.hasWorkingTreeChanges ?? null,
          }
        : {}),
    };
  });

  /**
   * Stop a child's provider process and wait for it to actually be gone.
   *
   * `thread.session.stop` only records the intent — ProviderCommandReactor
   * kills the process and writes `stopped` afterwards. Returning as soon as the
   * command lands would leave the caller free to delete a worktree the process
   * is still writing to, so this waits for the projected status.
   *
   * @returns whether the session reached "stopped" before the timeout, plus
   * what it was still doing if it did not — a settle that leaves a live
   * process behind has to say so rather than reporting a clean success.
   */
  const stopChildSession = Effect.fn("SessionsToolkit.stopChildSession")(function* (
    child: OrchestrationThreadShell,
  ) {
    const stopped = (): {
      readonly stopped: true;
      readonly lastStatus: null;
      readonly providerName: null;
    } => ({ stopped: true, lastStatus: null, providerName: null });
    if (!isSessionAlive(child.session?.status)) {
      return stopped();
    }
    yield* enqueue(
      engine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("mcp-settle-session-stop"),
        threadId: child.id,
        createdAt: yield* nowIso,
        // Same audit trail stop_session writes, so a settle-driven stop is not
        // an anonymous one in the record.
        stopReason: "parent_stopped",
        stoppedBy: "parent",
        // Deliberately no gracePeriodMs, and no partial report requested. A
        // grace period exists to let a working agent wrap up and report before
        // the axe falls; settle_session has already refused anything
        // starting/running, so by construction there is no work in flight to
        // wind down and nothing to report that the child could not have
        // reported already. Waiting out a grace period here would only delay
        // the settle — and, with cleanupWorktree, hold the worktree hostage —
        // for a session that is idle by definition.
        requestPartialReport: false,
      }),
    );

    let waitedMs = 0;
    let latest = child;
    while (waitedMs < SESSION_STOP_TIMEOUT_MS) {
      const shell = yield* getShell(child.id);
      // A thread that vanished (archived, deleted) has no process left to wait
      // on, and neither does one whose session is already gone.
      if (Option.isNone(shell) || !isSessionAlive(shell.value.session?.status)) {
        return stopped();
      }
      latest = shell.value;
      yield* Effect.sleep(Duration.millis(SESSION_STOP_POLL_INTERVAL_MS));
      waitedMs += SESSION_STOP_POLL_INTERVAL_MS;
    }
    return {
      stopped: false as const,
      lastStatus: latest.session?.status ?? null,
      providerName: latest.session?.providerName ?? null,
    };
  });

  /**
   * Turn a failed git mutation into the most useful error we can give.
   *
   * A `git worktree remove` that lost a race for the repository lock — or that
   * ran after another one was killed mid-write — fails with the lock file's
   * path, and every later git command on that repository fails the same way
   * until the file is gone. That deserves the path and the remedy, not a
   * generic "worktree could not be removed".
   */
  const describeGitFailure = Effect.fn("SessionsToolkit.describeGitFailure")(function* (params: {
    readonly cause: unknown;
    readonly fallbackMessage: string;
  }) {
    const causeMessage =
      params.cause instanceof Error ? params.cause.message : "unknown git failure";
    const lockPath = parseGitLockPath(causeMessage);
    if (lockPath === null) {
      return new SessionOrchestrationOperationError({
        message: `${params.fallbackMessage}: ${causeMessage}`,
      });
    }
    const stat = yield* Effect.option(fileSystem.stat(lockPath));
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const mtimeMs = Option.isSome(stat)
      ? Option.map(stat.value.mtime, (mtime) => mtime.getTime())
      : Option.none<number>();
    const ageMs = Option.isSome(mtimeMs) ? Math.max(0, nowMs - mtimeMs.value) : null;
    const staleness = assessGitLockStaleness({
      sizeBytes: Option.isSome(stat) ? Number(stat.value.size) : null,
      ageMs,
    });
    // Deliberately never removed here: see assessGitLockStaleness.
    const remedy = staleness.appearsStale
      ? `Confirm no git process is running against this repository, delete ${lockPath}, then retry settle_session.`
      : `Wait for the git process holding ${lockPath} to finish, then retry settle_session. If nothing is running, delete that file by hand.`;
    return new SessionOrchestrationGitLockError({
      message: `${params.fallbackMessage}: git could not take the repository lock at ${lockPath} (${staleness.detail}).`,
      lockPath,
      lockAgeMs: ageMs,
      appearsStale: staleness.appearsStale,
      remedy,
    });
  });

  /**
   * Prove a branch Phoenix did not create is safe to delete.
   *
   * This repository squash-merges, so a merged branch never becomes an
   * ancestor of main and `git branch --merged` reports nothing — using it here
   * would refuse every merged branch and, on a rebase-merge repo, accept
   * branches that were never merged at all. The proof is commit identity: the
   * local head, the remote head, and the head commit of a *merged* pull
   * request must all be the same commit, which also means zero commits ahead.
   *
   * The remote-tracking ref is read as last fetched rather than re-fetched: a
   * stale ref can only cost a false refusal, never a wrong deletion, because a
   * local branch that equals a merged PR head holds nothing that is not
   * already published.
   */
  const proveBranchMerged = Effect.fn("SessionsToolkit.proveBranchMerged")(function* (params: {
    readonly workspaceRoot: string;
    readonly branch: string;
  }) {
    const { workspaceRoot, branch } = params;
    const refuse = (input: {
      readonly reason: SessionOrchestrationBranchNotMergedError["reason"];
      readonly message: string;
      readonly localSha?: string | null;
      readonly remoteSha?: string | null;
      readonly mergedPullRequestNumber?: number | null;
      readonly mergedPullRequestHeadSha?: string | null;
    }) =>
      new SessionOrchestrationBranchNotMergedError({
        message: `Refusing to delete branch "${branch}": ${input.message}`,
        branch,
        reason: input.reason,
        localSha: input.localSha ?? null,
        remoteSha: input.remoteSha ?? null,
        mergedPullRequestNumber: input.mergedPullRequestNumber ?? null,
        mergedPullRequestHeadSha: input.mergedPullRequestHeadSha ?? null,
      });

    const localSha = yield* gitWorkflow
      .resolveCommit({ cwd: workspaceRoot, revision: branch })
      .pipe(
        Effect.map((resolved) => resolved.commitSha),
        Effect.mapError(operationError(`Failed to resolve the head of branch "${branch}"`)),
      );

    const remote = yield* Effect.option(
      gitWorkflow.resolveRemoteTrackingCommit({
        cwd: workspaceRoot,
        refName: branch,
        fallbackRemoteName: "origin",
      }),
    );
    if (Option.isNone(remote)) {
      return yield* refuse({
        reason: "remote_branch_missing",
        message: "it has no remote-tracking branch, so nothing proves its commits are published.",
        localSha,
      });
    }
    if (remote.value.commitSha !== localSha) {
      return yield* refuse({
        reason: "local_ahead_of_remote",
        message: `its local head (${localSha}) differs from ${remote.value.remoteRefName} (${remote.value.commitSha}), so it holds commits that are not published.`,
        localSha,
        remoteSha: remote.value.commitSha,
      });
    }

    const mergedPullRequests = yield* sourceControlProviders.resolve({ cwd: workspaceRoot }).pipe(
      Effect.flatMap((provider) =>
        provider.listChangeRequests({
          cwd: workspaceRoot,
          headSelector: branch,
          state: "merged",
          limit: 10,
        }),
      ),
      Effect.map(Option.some),
      Effect.catch((cause) =>
        Effect.logDebug("merged pull request lookup failed", { branch, cause }).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
    if (Option.isNone(mergedPullRequests)) {
      return yield* refuse({
        reason: "pull_request_lookup_unavailable",
        message:
          "its pull requests could not be read (the host CLI is missing, unauthenticated, or unreachable), so the merge cannot be proven.",
        localSha,
        remoteSha: remote.value.commitSha,
      });
    }
    const merged = mergedPullRequests.value.filter((pullRequest) => pullRequest.state === "merged");
    if (merged.length === 0) {
      return yield* refuse({
        reason: "no_merged_pull_request",
        message: "no merged pull request has it as the head branch.",
        localSha,
        remoteSha: remote.value.commitSha,
      });
    }
    const proven = merged.find((pullRequest) => pullRequest.headRefOid === localSha);
    if (proven === undefined) {
      const closest = merged[0];
      return yield* refuse({
        reason: "pull_request_head_mismatch",
        message: `its merged pull request${
          closest === undefined ? "" : ` (#${closest.number})`
        } was merged from a different commit than the branch head (${localSha}), so the branch has moved since.`,
        localSha,
        remoteSha: remote.value.commitSha,
        mergedPullRequestNumber: closest?.number ?? null,
        mergedPullRequestHeadSha: closest?.headRefOid ?? null,
      });
    }
    return `merged pull request #${proven.number} (${proven.url}) was merged from ${localSha}, which is also the local head and ${remote.value.remoteRefName}`;
  });

  /**
   * Reclaim a settled child's worktree, or explain why it was left alone.
   *
   * Spawned worktrees are otherwise never reclaimed — nothing else in the
   * server deletes them — so this is the one path that keeps a long
   * orchestration run from filling the disk.
   */
  const cleanupChildWorktree = Effect.fn("SessionsToolkit.cleanupChildWorktree")(
    function* (params: {
      readonly child: OrchestrationThreadShell;
      readonly input: SettleSessionInput;
    }) {
      const { child, input } = params;
      const kept = (detail: string | null): SettleSessionWorktreeOutcome => ({
        removedWorktreePath: null,
        removedBranch: null,
        keptWorktreePath: child.worktreePath,
        keptBranch: child.branch,
        detail,
        branchProof: null,
      });

      if (input.cleanupWorktree !== true) {
        if (input.cleanupBranch === true) {
          return yield* new SessionOrchestrationInvalidInputError({
            message:
              "cleanupBranch requires cleanupWorktree: true — a branch checked out in a worktree cannot be deleted while that worktree exists.",
          });
        }
        return kept(
          child.worktreePath === null
            ? null
            : "Worktree left in place; pass cleanupWorktree: true to delete it.",
        );
      }
      const worktreePath = child.worktreePath;
      if (worktreePath === null) {
        return kept("Thread has no isolated worktree to clean up.");
      }

      const project = yield* snapshotQuery
        .getProjectShellById(child.projectId)
        .pipe(Effect.mapError(operationError("Failed to read project")));
      if (Option.isNone(project)) {
        return yield* new SessionOrchestrationInvalidInputError({
          message: `Project ${child.projectId} was not found, so its worktree cannot be removed.`,
        });
      }
      const workspaceRoot = project.value.workspaceRoot;

      if (input.force !== true) {
        const status = yield* gitWorkflow
          .status({ cwd: worktreePath })
          .pipe(Effect.mapError(operationError(`Failed to inspect worktree ${worktreePath}`)));
        const risk = assessWorktreeCleanupRisk(status);
        if (risk.hasUnsavedWork) {
          return yield* new SessionOrchestrationWorktreeNotEmptyError({
            message: `Refusing to delete ${worktreePath}: it holds ${risk.dirtyFileCount} uncommitted file(s) and ${risk.unpushedCommitCount} commit(s) that exist nowhere else. Inspect it, or pass force: true to delete it anyway.`,
            worktreePath,
            branch: child.branch,
            dirtyFiles: risk.dirtyFiles,
            dirtyFileCount: risk.dirtyFileCount,
            unpushedCommitCount: risk.unpushedCommitCount,
            hasUpstream: risk.hasUpstream,
          });
        }
      }

      const branch = child.branch;
      const branchDecision = decideBranchCleanup(branch, {
        cleanupBranch: input.cleanupBranch,
      });
      // The proof runs before anything is destroyed: a branch that cannot be
      // proven merged refuses the whole cleanup with the worktree still on
      // disk, rather than leaving the caller with half a job done.
      const branchProof =
        branchDecision.requiresMergeProof && branch !== null
          ? yield* proveBranchMerged({ workspaceRoot, branch })
          : branchDecision.deleteBranch && branch !== null
            ? "it is a Phoenix temporary worktree branch"
            : null;

      // One repository, one worktree mutation at a time. Concurrent
      // `git worktree remove` runs on the same repository contend for
      // .git/index.lock, and the losers sit there until our command timeout
      // kills them — which is how eight parallel cleanups all failed while a
      // single sequential one succeeded. Branch deletion joins the same
      // critical section because it takes the ref lock in the same repository.
      const branchRemoval = yield* repositoryLock.withRepositoryLock(
        workspaceRoot,
        Effect.gen(function* () {
          // --force on the git side only covers a dirty tree; the decision to
          // destroy work was already made (or refused) above.
          yield* gitWorkflow
            .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true })
            .pipe(
              Effect.catch((cause) =>
                Effect.flatMap(
                  describeGitFailure({
                    cause,
                    fallbackMessage: `Thread ${child.id} was settled, but its worktree at ${worktreePath} could NOT be removed (the directory is still on disk)`,
                  }),
                  Effect.fail,
                ),
              ),
            );

          // A failed branch delete leaves a dangling ref, not lost work, so it
          // is reported rather than failing a settle whose destructive step is
          // already done.
          return branchDecision.deleteBranch && branch !== null
            ? yield* gitWorkflow
                .deleteRef({ cwd: workspaceRoot, refName: branch, force: true })
                .pipe(
                  Effect.as({ removedBranch: branch, detail: null as string | null }),
                  Effect.catch((cause) =>
                    Effect.succeed({
                      removedBranch: null,
                      detail: `Worktree removed, but branch "${branch}" could not be deleted: ${cause.message}`,
                    }),
                  ),
                )
            : { removedBranch: null, detail: branchDecision.detail };
        }),
      );

      // read_session must stop advertising a worktree that no longer exists.
      yield* enqueue(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("mcp-settle-session-worktree"),
          threadId: child.id,
          worktreePath: null,
          ...(branchRemoval.removedBranch !== null ? { branch: null } : {}),
        }),
      );

      return {
        removedWorktreePath: worktreePath,
        removedBranch: branchRemoval.removedBranch,
        keptWorktreePath: null,
        keptBranch: branchRemoval.removedBranch === null ? child.branch : null,
        detail: branchRemoval.detail,
        branchProof: branchRemoval.removedBranch === null ? null : branchProof,
      };
    },
  );

  const settleSession = Effect.fn("SessionsToolkit.settleSession")(function* (
    input: SettleSessionInput,
  ) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);

    // A turn in flight is never interrupted on the parent's say-so; that stays
    // an explicit stop_session. An idle-but-alive session is a different
    // matter — settling is the parent declaring the child finished, so the
    // process goes with it.
    if (isSessionBusy(child.session?.status)) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "session_still_running",
        message: `Thread ${child.id} is still ${child.session?.status}. Call stop_session first, or wait for it to finish, then settle it.`,
      });
    }

    const stop = yield* stopChildSession(child);

    // Settle before touching the filesystem: it is the reversible half, and a
    // worktree must never be deleted for a thread that turned out to be
    // unsettleable (open approval, queued turn).
    yield* startup
      .enqueueCommand(
        engine.dispatch({
          type: "thread.settle",
          commandId: yield* serverCommandId("mcp-settle-session"),
          threadId: child.id,
        }),
      )
      .pipe(Effect.mapError(operationError(`Failed to settle thread ${child.id}`)));

    // Deleting files under a process that refused to die is how a "cleanup"
    // corrupts a live turn. The thread is settled either way; the destructive
    // half is what gets withheld.
    if (!stop.stopped && input.cleanupWorktree === true) {
      return yield* new SessionOrchestrationOperationError({
        message: `Thread ${child.id} was settled, but its provider session did not reach "stopped" within ${SESSION_STOP_TIMEOUT_MS}ms, so its worktree was left untouched. Retry settle_session once the session has stopped.`,
      });
    }

    const worktree = yield* cleanupChildWorktree({ child, input });
    // Without cleanup there is nothing to withhold, so the settle succeeds —
    // but a process that outlived its stop is still holding a provider slot
    // and possibly writing to the worktree, and a silent success is how that
    // leak goes unnoticed until the machine is full of orphans.
    const warning = stop.stopped
      ? null
      : `Thread ${child.id} was settled, but its ${
          stop.providerName ?? "provider"
        } session did not reach "stopped" within ${SESSION_STOP_TIMEOUT_MS}ms (last seen "${
          stop.lastStatus ?? "unknown"
        }"). The process may still be running; check the thread, or call stop_session again.`;
    return { threadId: child.id, settled: true, worktree, warning };
  });

  const pingSession = Effect.fn("SessionsToolkit.pingSession")(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    // Purpose-built, bounded reads instead of a thread detail snapshot: each
    // is a single-row query independent of turn boundaries — a windowed
    // detail read would wrongly report no assistant message when the newest
    // turn happens to be user-only — and each degrades to a safe default on
    // failure for the same reason as getLastActivityAt: optional enrichment
    // must never fail the ping.
    const hasReport = yield* snapshotQuery
      .getThreadHasReport(child.id)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    const lastAssistantMessage = yield* snapshotQuery.getLastAssistantMessage(child.id).pipe(
      Effect.map(Option.map((message) => message.text)),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    const lastActivityAt = yield* getLastActivityAt(child.id);
    const usage = yield* resolveSessionUsageSnapshot(snapshotQuery, {
      threadId: child.id,
      createdAt: child.createdAt,
      latestTurn: child.latestTurn,
    });
    return {
      threadId: child.id,
      ...buildPingSessionSnapshot({
        shell: child,
        lastActivityAt,
        hasReport,
        lastAssistantMessage: Option.getOrNull(lastAssistantMessage),
        usage,
      }),
    };
  });

  const postReport = Effect.fn("SessionsToolkit.postReport")(function* (input: PostReportInput) {
    const scope = yield* requireSessionsCapability;
    const caller = yield* requireShell(scope.threadId);

    // Friendly pre-check. The decider runs the same check against the folded
    // read model and is the authority — this one exists so the common case
    // fails with a specific, structured error instead of a dispatch failure.
    // Reading the whole thread's reports (rather than one row) is what makes
    // the chain-head answer available.
    const supersedesReportId = input.supersedesReportId;
    if (supersedesReportId !== undefined) {
      const reports = yield* reportRepository
        .listByThreadId({ threadId: scope.threadId })
        .pipe(Effect.mapError(operationError("Failed to read this session's reports")));
      const check = checkReportSupersession(reports, supersedesReportId);
      if (check._tag === "unknown-report") {
        return yield* new SessionOrchestrationInvalidInputError({
          message: SUPERSEDES_REPORT_NOT_FOUND_MESSAGE,
        });
      }
      if (check._tag === "already-superseded") {
        return yield* new SessionOrchestrationReportAlreadySupersededError({
          message: reportAlreadySupersededMessage({
            reportId: supersedesReportId,
            supersededByReportId: check.supersededByReportId,
            chainHeadReportId: check.chainHeadReportId,
          }),
          reportId: supersedesReportId,
          supersededByReportId: check.supersededByReportId,
          chainHeadReportId: check.chainHeadReportId,
        });
      }
    }

    /**
     * Turn a lost amendment race into the same actionable error the pre-check
     * would have given.
     *
     * Between the pre-check and the decider, another amendment can take the
     * chain head. The decider rejects this command — correctly — but through
     * dispatch that surfaces as a generic operation failure, which tells the
     * caller nothing about where to re-attach. So on failure, re-read the
     * chain: if it moved, report that; otherwise the dispatch failed for some
     * other reason and that error stands.
     */
    const withSupersessionRaceDetail = (
      effect: Effect.Effect<{ readonly sequence: number }, SessionOrchestrationOperationError>,
    ): Effect.Effect<
      { readonly sequence: number },
      SessionOrchestrationOperationError | SessionOrchestrationReportAlreadySupersededError
    > =>
      supersedesReportId === undefined
        ? effect
        : effect.pipe(
            Effect.catch((dispatchError) =>
              reportRepository.listByThreadId({ threadId: scope.threadId }).pipe(
                // The recheck is diagnostic only; if it fails, the original
                // dispatch error is still the truthful thing to report.
                Effect.catch(() => Effect.succeed<ReadonlyArray<ProjectionThreadReport>>([])),
                Effect.flatMap((reports) => {
                  const check = checkReportSupersession(reports, supersedesReportId);
                  return check._tag === "already-superseded"
                    ? Effect.fail<
                        | SessionOrchestrationOperationError
                        | SessionOrchestrationReportAlreadySupersededError
                      >(
                        new SessionOrchestrationReportAlreadySupersededError({
                          message: reportAlreadySupersededMessage({
                            reportId: supersedesReportId,
                            supersededByReportId: check.supersededByReportId,
                            chainHeadReportId: check.chainHeadReportId,
                          }),
                          reportId: supersedesReportId,
                          supersededByReportId: check.supersededByReportId,
                          chainHeadReportId: check.chainHeadReportId,
                        }),
                      )
                    : Effect.fail(dispatchError);
                }),
              ),
            ),
          );

    const createdAt = yield* nowIso;
    const reportId = yield* randomUUID;
    // Captured now, not agent-supplied: what this session cost by the time
    // it reported, so the parent can budget without polling.
    const usage = yield* resolveSessionUsageSnapshot(snapshotQuery, {
      threadId: scope.threadId,
      createdAt: caller.createdAt,
      latestTurn: caller.latestTurn,
    });
    yield* withSupersessionRaceDetail(
      enqueue(
        engine.dispatch({
          type: "thread.report.post",
          commandId: yield* serverCommandId("mcp-post-report"),
          threadId: scope.threadId,
          reportId,
          status: input.status,
          title: input.title,
          summary: input.summary,
          ...(input.abstract !== undefined ? { abstract: input.abstract } : {}),
          artifacts: input.artifacts ?? [],
          ...(input.findings !== undefined ? { findings: input.findings } : {}),
          ...(input.validation !== undefined ? { validation: input.validation } : {}),
          ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
          ...(input.completionPercent !== undefined
            ? { completionPercent: input.completionPercent }
            : {}),
          usage,
          ...(input.supersedesReportId !== undefined
            ? { supersedesReportId: input.supersedesReportId }
            : {}),
          createdAt,
        }),
      ),
    );
    return {
      reportId,
      threadId: scope.threadId,
      status: input.status,
      title: input.title,
      summary: input.summary,
      ...(input.abstract !== undefined ? { abstract: input.abstract } : {}),
      artifacts: input.artifacts ?? [],
      ...(input.findings !== undefined ? { findings: input.findings } : {}),
      ...(input.validation !== undefined ? { validation: input.validation } : {}),
      ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
      ...(input.completionPercent !== undefined
        ? { completionPercent: input.completionPercent }
        : {}),
      usage,
      ...(input.supersedesReportId !== undefined
        ? { supersedesReportId: input.supersedesReportId }
        : {}),
      // post_report is by definition the agent speaking for itself; only the
      // reactor's terminal reports are system-origin.
      origin: "agent" as const,
      createdAt,
    };
  });

  const readReport = Effect.fn("SessionsToolkit.readReport")(function* (input: ReadReportInput) {
    const scope = yield* requireSessionsCapability;
    if (input.reportId === undefined && input.threadId === undefined) {
      return yield* new SessionOrchestrationInvalidInputError({
        message: "Pass reportId (from a report envelope), threadId, or both.",
      });
    }
    const caller = yield* requireShell(scope.threadId);

    // Every unreadable case fails with this one error so responses cannot
    // distinguish unknown, foreign, archived, mismatched, or report-less
    // targets from each other.
    const reportNotAccessible = () =>
      new SessionOrchestrationDeniedError({
        reason: "report_not_accessible",
        message: REPORT_NOT_ACCESSIBLE_MESSAGE,
      });
    const mayReadThread = (targetThreadId: ThreadId) =>
      getShell(targetThreadId).pipe(
        Effect.map(
          (shell) =>
            Option.isSome(shell) &&
            canReadThreadReports({
              callerThreadId: scope.threadId,
              callerSpawnedByThreadId: caller.spawnedByThreadId ?? null,
              targetThreadId,
              targetSpawnedByThreadId: shell.value.spawnedByThreadId ?? null,
            }),
        ),
      );

    // When the target thread is named, authorize it before touching any
    // report rows; only the reportId-only path has to resolve the row first
    // to learn which thread to authorize, and its failures are
    // indistinguishable from the pre-authorized paths' by construction. The
    // residual signal in that path is timing (a row lookup happens before the
    // denial); acceptable only because reportIds are server-generated v4
    // UUIDs — unguessable, so there is nothing to probe by dictionary.
    if (input.threadId !== undefined && !(yield* mayReadThread(input.threadId))) {
      return yield* reportNotAccessible();
    }

    let report: ProjectionThreadReport;
    if (input.reportId !== undefined) {
      const found = yield* reportRepository
        .findByReportId({ reportId: input.reportId })
        .pipe(Effect.mapError(operationError("Failed to read report")));
      if (Option.isNone(found)) {
        return yield* reportNotAccessible();
      }
      if (input.threadId !== undefined) {
        if (found.value.threadId !== input.threadId) {
          return yield* reportNotAccessible();
        }
      } else if (!(yield* mayReadThread(found.value.threadId))) {
        return yield* reportNotAccessible();
      }
      report = found.value;
    } else {
      const reports = yield* reportRepository
        // threadId is defined here: the missing-both case returned above.
        .listByThreadId({ threadId: input.threadId as ThreadId })
        .pipe(Effect.mapError(operationError("Failed to read reports")));
      const latest = reports.at(-1);
      if (latest === undefined) {
        return yield* reportNotAccessible();
      }
      report = latest;
    }

    const page = sliceReportBody(report.summary, {
      offset: input.offset,
      maxChars: input.maxChars,
    });
    return {
      reportId: report.reportId,
      threadId: report.threadId,
      status: report.status,
      title: report.title,
      origin: report.origin,
      body: page.body,
      offset: page.offset,
      totalChars: page.totalChars,
      hasMore: page.hasMore,
      // Full structured data on every page; the envelope only carried counts.
      ...(report.findings !== undefined ? { findings: report.findings } : {}),
      ...(report.validation !== undefined ? { validation: report.validation } : {}),
      ...(report.recommendation !== undefined ? { recommendation: report.recommendation } : {}),
      ...(report.completionPercent !== undefined
        ? { completionPercent: report.completionPercent }
        : {}),
      artifacts: report.artifacts,
      ...(report.usage !== undefined ? { usage: report.usage } : {}),
      ...(report.supersedesReportId !== null
        ? { supersedesReportId: report.supersedesReportId }
        : {}),
      // A caller paging an old body must learn a newer account exists — both
      // as an id it can follow and as prose it cannot skim past.
      ...(report.supersededByReportId !== undefined
        ? {
            supersededByReportId: report.supersededByReportId,
            supersededNotice: supersededReportNotice(report.supersededByReportId),
          }
        : {}),
      createdAt: report.createdAt,
    };
  });

  const stopSession = Effect.fn("SessionsToolkit.stopSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly gracePeriodMs?: number | undefined;
    readonly requestPartialReport?: boolean | undefined;
  }) {
    const scope = yield* requireSessionsCapability;
    const child = yield* requireSpawnedChild(scope.threadId, input.threadId);
    yield* enqueue(
      engine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("mcp-stop-session"),
        threadId: child.id,
        createdAt: yield* nowIso,
        stopReason: "parent_stopped",
        stoppedBy: "parent",
        ...(input.gracePeriodMs !== undefined ? { gracePeriodMs: input.gracePeriodMs } : {}),
        requestPartialReport: input.requestPartialReport ?? false,
      }),
    );
    return { threadId: child.id, status: "stop-requested" as const };
  });

  return {
    list_session_providers: (input) => listProviders(input ?? {}),
    spawn_session: (input) => spawnSession(input),
    send_to_session: (input) => sendToSession(input),
    read_session: (input) => readSession(input),
    read_report: (input) => readReport(input ?? {}),
    ping_session: (input) => pingSession(input),
    stop_session: (input) => stopSession(input),
    settle_session: (input) => settleSession(input),
    post_report: (input) => postReport(input),
  } satisfies Parameters<typeof SessionsToolkit.toLayer>[0];
});

export const SessionsToolkitHandlersLive = SessionsToolkit.toLayer(make);
