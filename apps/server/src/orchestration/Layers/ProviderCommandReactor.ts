import * as QueuedDelivery from "../QueuedDelivery.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProviderConversationSeed,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { buildConversationSeed } from "../../provider/conversationSeed.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.migrated";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
// A wedged provider transport must not jam the reactor's single worker behind
// every later command — exactly during a runaway turn, Stop matters most.
const PROVIDER_INTERRUPT_TIMEOUT_SECONDS = 10;
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = assistantCitationsToPlainText(message.text).trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

// The adapter has no live context for this thread — its runtime died with a
// previous process or was never started. Nothing is running provider-side, so
// the stuck turn can be settled as crashed rather than left "running".
function hasProviderAdapterSessionNotFoundError(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && isProviderAdapterSessionNotFoundError(reason.error),
  );
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = (options?: { readonly interruptTimeoutSeconds?: number }) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerAuthService = yield* ProviderAuthService;
    const providerService = yield* ProviderService;
    const delivery = yield* QueuedDelivery.QueuedDelivery;
    const providerRegistry = yield* ProviderRegistry;
    const gitWorkflow = yield* GitWorkflowService;
    const fileSystem = yield* FileSystem.FileSystem;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
    const textGeneration = yield* TextGeneration;
    const serverSettingsService = yield* ServerSettingsService;
    /** Environment settings with the thread's project overrides applied. */
    const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      const settings = yield* serverSettingsService.getSettings;
      if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
        .settings;
    });
    const serverCommandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
    const interruptTimeoutSeconds = Math.max(
      1,
      options?.interruptTimeoutSeconds ?? PROVIDER_INTERRUPT_TIMEOUT_SECONDS,
    );
    const handledTurnStartKeys = yield* Cache.make<string, true>({
      capacity: HANDLED_TURN_START_KEY_MAX,
      timeToLive: HANDLED_TURN_START_KEY_TTL,
      lookup: () => Effect.succeed(true),
    });

    const hasHandledTurnStartRecently = (key: string) =>
      Cache.getOption(handledTurnStartKeys, key).pipe(
        Effect.flatMap((cached) =>
          Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
        ),
      );

    const threadModelSelections = new Map<string, ModelSelection>();
    const compactingThreadIds = new Set<ThreadId>();
    type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
    // Turn starts received while a thread compacts, replayed in order once its session is restored.
    const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
    // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
    // provider send finishes, which is what lets the next queued turn follow it in order.
    const resumedTurnStarts = new Map<
      CommandId,
      {
        readonly event: QueuedTurnStart;
        readonly queued: Array<QueuedTurnStart>;
        readonly sent: Deferred.Deferred<void>;
      }
    >();
    const stoppingThreadIds = new Set<ThreadId>();
    const armedGraceStopEpisodes = new Set<string>();

    const appendProviderFailureActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind:
        | "provider.turn.start.failed"
        | "provider.turn.interrupt.failed"
        | "provider.approval.respond.failed"
        | "provider.user-input.respond.failed"
        | "provider.session.stop.failed";
      readonly summary: string;
      readonly detail: string;
      readonly turnId: TurnId | null;
      readonly createdAt: string;
      readonly requestId?: string;
    }) =>
      Effect.all({
        commandId: serverCommandId("provider-failure-activity"),
        eventId: serverEventId(),
      }).pipe(
        Effect.flatMap(({ commandId, eventId }) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: "error",
              kind: input.kind,
              summary: input.summary,
              payload: {
                detail: input.detail,
                ...(input.requestId ? { requestId: input.requestId } : {}),
              },
              turnId: input.turnId,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          }),
        ),
      );

    const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
      threadId: ThreadId,
      detail: string,
    ) {
      const queued = turnsAfterCompaction.get(threadId) ?? [];
      turnsAfterCompaction.delete(threadId);
      for (const event of queued) {
        yield* appendProviderFailureActivity({
          threadId,
          kind: "provider.turn.start.failed",
          summary: "Queued message was not sent",
          detail,
          turnId: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          requestId: event.payload.messageId,
        }).pipe(Effect.ignore({ log: true, message: "failed to report canceled queued message" }));
      }
    });

    const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
      threadId: ThreadId,
    ) {
      const queued = turnsAfterCompaction.get(threadId) ?? [];
      while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
        const event = queued[0]!;
        const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
          threadId,
          messageId: event.payload.messageId,
        });
        if (turnsAfterCompaction.get(threadId) !== queued) return;
        // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
        queued.shift();
        if (Option.isNone(turnStart)) continue;
        // Reissue the durable request after restoration clears compaction's
        // pending slot. Reusing the message id preserves a single user bubble.
        const commandId = yield* serverCommandId("after-compaction");
        const sent = yield* Deferred.make<void>();
        resumedTurnStarts.set(commandId, { event, queued, sent });
        const { messageId, ...request } = event.payload;
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId,
            ...request,
            message: {
              messageId,
              role: "user",
              text: turnStart.value.message.text,
              attachments: turnStart.value.message.attachments ?? [],
            },
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                resumedTurnStarts.delete(commandId);
                queued.unshift(event);
              }),
            ),
          );
        yield* Deferred.await(sent);
        resumedTurnStarts.delete(commandId);
      }
      if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
    });

    const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
      const failReason = cause.reasons.find(Cause.isFailReason);
      if (isProviderAdapterRequestError(failReason?.error)) {
        return failReason.error.detail;
      }
      if (isProviderAdapterValidationError(failReason?.error)) {
        return failReason.error.issue;
      }
      if (isProviderWorkspaceMissingError(failReason?.error)) {
        return failReason.error.message;
      }
      return Cause.pretty(cause);
    };

    const setThreadSession = (input: {
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession;
      readonly createdAt: string;
    }) =>
      serverCommandId("provider-session-set").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId,
            threadId: input.threadId,
            session: input.session,
            createdAt: input.createdAt,
          }),
        ),
      );

    const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly detail: string;
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThreadShell(input.threadId);
      if (!thread) {
        return;
      }
      const session = thread.session;
      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          ...(session ?? {
            threadId: input.threadId,
            providerName: null,
            providerInstanceId: thread.modelSelection.instanceId,
            runtimeMode: thread.runtimeMode,
          }),
          status: session?.status === "stopped" ? "stopped" : "error",
          activeTurnId: null,
          lastError: input.detail,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

    const restoreCompaction = Effect.fnUntraced(function* (
      threadId: ThreadId,
      fromRunning = false,
    ) {
      if (stoppingThreadIds.has(threadId)) {
        compactingThreadIds.delete(threadId);
        return;
      }
      const thread = yield* resolveThreadShell(threadId);
      if (!thread?.session) return;
      if (
        thread.session.status !== "starting" &&
        thread.session.status !== "ready" &&
        (!fromRunning || thread.session.status !== "running")
      )
        return;
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      if (stoppingThreadIds.has(threadId)) {
        compactingThreadIds.delete(threadId);
        return;
      }
      yield* setThreadSession({
        threadId,
        session: {
          ...thread.session,
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: completedAt,
        },
        createdAt: completedAt,
      });
    });

    const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
      return yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined));
    });

    /**
     * Recreates a thread's worktree from its branch when the directory has
     * disappeared. Provider sessions resume into the persisted cwd, so a missing
     * worktree makes every later turn fail as a bogus "session not found".
     * Best-effort: on failure the turn proceeds and reports the real error.
     */
    const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }) {
      const { worktreePath, branch } = thread;
      if (!worktreePath || !branch) {
        return;
      }
      const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
      if (exists) {
        return;
      }
      const project = yield* resolveProject(thread.projectId);
      if (!project) {
        return;
      }
      const cwd = project.workspaceRoot;
      yield* Effect.logWarning("provider command reactor recreating missing worktree", {
        threadId: thread.id,
        worktreePath,
        branch,
      });
      // A directory deleted without `git worktree remove` leaves an admin entry
      // that makes `git worktree add` refuse the path; prune clears it.
      yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
        Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor failed to recreate worktree", {
                threadId: thread.id,
                worktreePath,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    });

    const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
      return yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
    });

    const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
      return yield* projectionSnapshotQuery
        .getThreadDetailById(threadId, { activityKinds: [] })
        .pipe(Effect.map(Option.getOrUndefined));
    });

    // Stop needs only the latest tool audit entries, never conversation bodies.
    const resolveThreadStopContext = Effect.fnUntraced(function* (threadId: ThreadId) {
      const thread = yield* resolveThreadShell(threadId);
      if (!thread) return undefined;
      return { ...thread, ...(yield* projectionSnapshotQuery.getThreadStopAudit(threadId)) };
    });

    const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly currentModelSelection: ModelSelection;
      readonly requestedModelSelection: ModelSelection | undefined;
    }) {
      const requestedModelSelection = input.requestedModelSelection;
      if (
        requestedModelSelection === undefined ||
        (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
          input.currentModelSelection.model === requestedModelSelection.model)
      ) {
        return;
      }
      const providers = yield* providerRegistry.getProviders;
      const requiresNewThread =
        providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
          ?.requiresNewThreadForModelChange === true ||
        providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
          ?.requiresNewThreadForModelChange === true;
      if (!requiresNewThread) {
        return;
      }
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabelFromInstanceHint({
          instanceId: String(requestedModelSelection.instanceId),
          modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
        }),
        method: "thread.turn.start",
        detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
      });
    });

    const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
      threadId: ThreadId,
      createdAt: string,
      options?: {
        readonly modelSelection?: ModelSelection;
        readonly pendingTurnStart?: boolean;
        readonly queuedDeliveryMessageId?: MessageId | null;
        // Thread migration deliberately crosses the instance guard: the session
        // restarts on the target instance, and the native resume cursor is kept
        // only when the continuation identities match (same CLI home).
        readonly allowMigration?: boolean;
        readonly migrationBrief?: string;
      },
    ) {
      const thread = yield* resolveThreadShell(threadId);
      if (!thread) {
        return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
      }

      const desiredRuntimeMode = thread.runtimeMode;
      const requestedModelSelection = options?.modelSelection;
      // A migrated thread can briefly leave a stale runtime entry for the old
      // instance behind, and the read-model binding can lag the rebind by an
      // event. Prefer the effective selection's session, then the recorded
      // binding, and never read a stopped entry — otherwise the guard computes
      // the thread's account from the wrong session.
      const desiredInstanceIdHint = (requestedModelSelection ?? thread.modelSelection).instanceId;
      const resolveActiveSession = (threadId: ThreadId) =>
        providerService.listSessions().pipe(
          Effect.map((sessions) => {
            const matches = sessions.filter(
              (session) => session.threadId === threadId && session.status !== "closed",
            );
            const boundInstanceId = thread.session?.providerInstanceId;
            return (
              matches.find((session) => session.providerInstanceId === desiredInstanceIdHint) ??
              matches.find(
                (session) =>
                  boundInstanceId !== undefined && session.providerInstanceId === boundInstanceId,
              ) ??
              matches[0]
            );
          }),
        );

      const activeSession = yield* resolveActiveSession(threadId);
      const activeThreadSession =
        thread.session !== null && thread.session.status !== "stopped" && activeSession
          ? thread.session
          : null;
      if (
        activeThreadSession !== null &&
        activeSession !== undefined &&
        (activeThreadSession.providerInstanceId === undefined ||
          activeSession.providerInstanceId === undefined)
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
          method: "thread.turn.start",
          detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
        });
      }
      // A live runtime session is the strongest truth about which account the
      // thread is on: the read-model slot can be clobbered by a stale
      // instance's late stop event (observed live: the old account's stop
      // landed after the migration bind and overwrote the session as
      // "stopped" on the old instance).
      const currentInstanceId =
        activeSession !== undefined && activeSession.providerInstanceId !== undefined
          ? activeSession.providerInstanceId
          : (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId);
      const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
      const desiredInstanceId = desiredModelSelection.instanceId;
      const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(currentInstanceId),
                modelSelectionInstanceId: String(thread.modelSelection.instanceId),
                sessionProvider: thread.session?.providerName ?? undefined,
              }),
              method: "thread.turn.start",
              detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
            }),
        ),
      );
      const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(desiredModelSelection.instanceId),
              }),
              method: "thread.turn.start",
              detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
            }),
        ),
      );
      const desiredDriverKind = desiredInfo.driverKind;
      if (!isProviderDriverKind(desiredDriverKind)) {
        return yield* new ProviderAdapterRequestError({
          provider: providerErrorLabel(String(desiredDriverKind)),
          method: "thread.turn.start",
          detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
        });
      }
      const preferredProvider: ProviderDriverKind = desiredDriverKind;
      const startsNewEpisode =
        thread.session === null ||
        thread.session.status === "stopped" ||
        thread.session.status === "error";
      const episodeStartedAt = startsNewEpisode
        ? createdAt
        : (thread.session.episodeStartedAt ?? thread.session.updatedAt);
      if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: activeSession?.provider ?? preferredProvider,
            providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
            runtimeMode: desiredRuntimeMode,
            activeTurnId: null,
            lastError: null,
            stoppedBy: startsNewEpisode ? null : (thread.session?.stoppedBy ?? null),
            stopRequestedAt: startsNewEpisode ? null : (thread.session?.stopRequestedAt ?? null),
            stopReason: startsNewEpisode ? null : (thread.session?.stopReason ?? null),
            interruptedToolCall: startsNewEpisode
              ? false
              : (thread.session?.interruptedToolCall ?? false),
            lastCompletedOperation: thread.session?.lastCompletedOperation ?? null,
            graceStopDeadlineAt: startsNewEpisode
              ? null
              : (thread.session?.graceStopDeadlineAt ?? null),
            graceStopEpisodeId: startsNewEpisode
              ? null
              : (thread.session?.graceStopEpisodeId ?? null),
            episodeStartedAt,
            queuedDeliveryMessageId: options?.queuedDeliveryMessageId ?? null,
            updatedAt: createdAt,
          },
          createdAt,
        });
      }
      if (thread.session !== null) {
        yield* rejectStartedThreadModelChangeIfRequired({
          threadId,
          currentModelSelection:
            activeSession?.model !== undefined
              ? {
                  ...thread.modelSelection,
                  instanceId: currentInstanceId,
                  model: activeSession.model,
                }
              : thread.modelSelection,
          requestedModelSelection,
        });
      }
      // Compare the effective selection, not just the request payload: a
      // thread.meta.update can rewrite thread.modelSelection between turns, and a
      // selection-less turn.start must not slip past the instance guard.
      if (
        thread.session !== null &&
        desiredInstanceId !== currentInstanceId &&
        options?.allowMigration !== true
      ) {
        if (currentInfo.driverKind !== desiredInfo.driverKind) {
          return yield* new ProviderAdapterRequestError({
            provider: preferredProvider,
            method: "thread.turn.start",
            detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
          });
        }
        if (
          currentInfo.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: preferredProvider,
            method: "thread.turn.start",
            detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
          });
        }
      }
      const project = yield* resolveProject(thread.projectId);
      const effectiveCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      const refreshWorkspaceSnapshot = effectiveCwd
        ? providerRegistry
            .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
            .pipe(Effect.forkDetach)
        : Effect.void;

      // A session on a different continuation identity cannot resume natively,
      // so a migrating thread is seeded from Phoenix's own transcript instead.
      const continuationCompatible =
        currentInfo.continuationIdentity.continuationKey ===
        desiredInfo.continuationIdentity.continuationKey;
      const buildMigrationSeed = Effect.gen(function* () {
        if (continuationCompatible) {
          return undefined;
        }
        const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
        if (Option.isNone(detail)) {
          return undefined;
        }
        const build = buildConversationSeed({
          messages: detail.value.messages,
          ...(options?.migrationBrief !== undefined ? { brief: options.migrationBrief } : {}),
        });
        if (build.seed.messages.length === 0 && build.seed.brief === undefined) {
          return undefined;
        }
        if (build.droppedMessageCount > 0 || build.truncatedMessageCount > 0) {
          yield* Effect.logInfo("provider command reactor bounded migration seed", {
            threadId,
            keptMessages: build.seed.messages.length,
            droppedMessages: build.droppedMessageCount,
            truncatedMessages: build.truncatedMessageCount,
          });
        }
        return build.seed;
      });

      const startProviderSession = (input?: {
        readonly resumeCursor?: unknown;
        readonly provider?: ProviderDriverKind;
        readonly seed?: ProviderConversationSeed;
      }) =>
        providerService
          .startSession(threadId, {
            threadId,
            ...(preferredProvider ? { provider: preferredProvider } : {}),
            providerInstanceId: desiredInstanceId,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            ...(thread.title ? { title: thread.title } : {}),
            modelSelection: desiredModelSelection,
            ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            ...(input?.seed !== undefined ? { seed: input.seed } : {}),
            runtimeMode: desiredRuntimeMode,
          })
          .pipe(Effect.tap(() => refreshWorkspaceSnapshot));

      const bindSessionToThread = (session: ProviderSession) =>
        Effect.gen(function* () {
          if (session.providerInstanceId === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(session.provider),
              method: "thread.turn.start",
              detail: `Provider session '${session.threadId}' started without a provider instance id.`,
            });
          }
          yield* setThreadSession({
            threadId,
            session: {
              threadId,
              status:
                options?.pendingTurnStart === true && session.status === "ready"
                  ? "starting"
                  : mapProviderSessionStatusToOrchestrationStatus(session.status),
              providerName: session.provider,
              providerInstanceId: session.providerInstanceId,
              runtimeMode: desiredRuntimeMode,
              // Provider turn ids are not orchestration turn ids.
              activeTurnId: null,
              lastError: session.lastError ?? null,
              stoppedBy: startsNewEpisode ? null : (thread.session?.stoppedBy ?? null),
              stopRequestedAt: startsNewEpisode ? null : (thread.session?.stopRequestedAt ?? null),
              stopReason: startsNewEpisode ? null : (thread.session?.stopReason ?? null),
              interruptedToolCall: startsNewEpisode
                ? false
                : (thread.session?.interruptedToolCall ?? false),
              lastCompletedOperation: thread.session?.lastCompletedOperation ?? null,
              graceStopDeadlineAt: startsNewEpisode
                ? null
                : (thread.session?.graceStopDeadlineAt ?? null),
              graceStopEpisodeId: startsNewEpisode
                ? null
                : (thread.session?.graceStopEpisodeId ?? null),
              episodeStartedAt,
              queuedDeliveryMessageId:
                options?.queuedDeliveryMessageId !== undefined
                  ? options.queuedDeliveryMessageId
                  : (thread.session?.queuedDeliveryMessageId ?? null),
              updatedAt: session.updatedAt,
            },
            createdAt,
          });
        });

      const existingSessionThreadId =
        thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
      if (existingSessionThreadId) {
        const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
        const cwdChanged = effectiveCwd !== activeSession?.cwd;
        const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
          .sessionModelSwitch;
        const modelChanged =
          requestedModelSelection !== undefined &&
          requestedModelSelection.model !== activeSession?.model;
        const instanceChanged = activeSession?.providerInstanceId !== desiredInstanceId;
        const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
        const previousModelSelection = threadModelSelections.get(threadId);
        const shouldRestartForModelSelectionChange =
          preferredProvider === "claudeAgent" &&
          requestedModelSelection !== undefined &&
          !Equal.equals(previousModelSelection, requestedModelSelection);

        if (
          !runtimeModeChanged &&
          !cwdChanged &&
          !instanceChanged &&
          !shouldRestartForModelChange &&
          !shouldRestartForModelSelectionChange
        ) {
          yield* refreshWorkspaceSnapshot;
          return existingSessionThreadId;
        }

        const resumeCursor =
          shouldRestartForModelChange || !continuationCompatible
            ? undefined
            : (activeSession?.resumeCursor ?? undefined);
        yield* Effect.logInfo("provider command reactor restarting provider session", {
          threadId,
          existingSessionThreadId,
          currentProvider: activeSession?.provider,
          currentInstanceId,
          desiredInstanceId,
          desiredProvider: desiredModelSelection.instanceId,
          currentRuntimeMode: thread.session?.runtimeMode,
          desiredRuntimeMode: thread.runtimeMode,
          runtimeModeChanged,
          previousCwd: activeSession?.cwd,
          desiredCwd: effectiveCwd,
          cwdChanged,
          modelChanged,
          instanceChanged,
          shouldRestartForModelChange,
          shouldRestartForModelSelectionChange,
          hasResumeCursor: resumeCursor !== undefined,
        });
        const migrationSeed = resumeCursor === undefined ? yield* buildMigrationSeed : undefined;
        const restartedSession = yield* startProviderSession({
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          ...(migrationSeed !== undefined ? { seed: migrationSeed } : {}),
        });
        yield* Effect.logInfo("provider command reactor restarted provider session", {
          threadId,
          previousSessionId: existingSessionThreadId,
          restartedSessionThreadId: restartedSession.threadId,
          provider: restartedSession.provider,
          runtimeMode: restartedSession.runtimeMode,
          cwd: restartedSession.cwd,
        });
        yield* bindSessionToThread(restartedSession);
        return restartedSession.threadId;
      }

      const freshSeed = yield* buildMigrationSeed;
      const startedSession = yield* startProviderSession(
        freshSeed !== undefined ? { seed: freshSeed } : undefined,
      );
      yield* bindSessionToThread(startedSession);
      return startedSession.threadId;
    });

    const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly modelSelection?: ModelSelection;
      readonly interactionMode?: "default" | "plan";
      readonly queuedDeliveryMessageId?: MessageId | null;
      readonly createdAt: string;
    }) {
      const thread = yield* resolveThreadShell(input.threadId);
      if (!thread) {
        return yield* Effect.die(
          new Error(`Thread '${input.threadId}' was not found in read model.`),
        );
      }
      yield* ensureSessionForThread(input.threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        pendingTurnStart: true,
        ...(input.queuedDeliveryMessageId !== undefined
          ? { queuedDeliveryMessageId: input.queuedDeliveryMessageId }
          : {}),
      });
      if (input.modelSelection !== undefined) {
        threadModelSelections.set(input.threadId, input.modelSelection);
      }
      const normalizedInput = toNonEmptyProviderInput(input.messageText);
      const normalizedAttachments = input.attachments ?? [];
      const activeSession = yield* providerService
        .listSessions()
        .pipe(
          Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
        );
      const sessionModelSwitch =
        activeSession === undefined
          ? "in-session"
          : activeSession.providerInstanceId === undefined
            ? yield* new ProviderAdapterRequestError({
                provider: providerErrorLabel(activeSession.provider),
                method: "thread.turn.start",
                detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
              })
            : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
                .sessionModelSwitch;
      const requestedModelSelection =
        input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
      const modelForTurn =
        sessionModelSwitch === "unsupported" && input.modelSelection === undefined
          ? activeSession?.model !== undefined
            ? {
                ...requestedModelSelection,
                model: activeSession.model,
              }
            : requestedModelSelection
          : input.modelSelection;

      return {
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      };
    });

    const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
      "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }) {
      if (!input.branch || !input.worktreePath) {
        return;
      }
      if (!isTemporaryWorktreeBranch(input.branch)) {
        return;
      }

      const oldBranch = input.branch;
      const cwd = input.worktreePath;
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const settings = yield* projectSettingsForThread(input.threadId);
        const modelSelection =
          settings.sourceControlWriterModelSelection === null
            ? settings.textGenerationModelSelection
            : resolveSourceControlWriterModelSelection(
                settings,
                yield* providerRegistry.getProviders,
              );

        const generated = yield* textGeneration.generateBranchName({
          cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
        if (targetBranch === oldBranch) return;

        const renamed = yield* gitWorkflow.renameBranch({
          cwd,
          oldBranch,
          newBranch: targetBranch,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("worktree-branch-rename"),
          threadId: input.threadId,
          branch: renamed.branch,
          worktreePath: cwd,
        });
        yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            {
              threadId: input.threadId,
              cwd,
              oldBranch,
              cause: Cause.pretty(cause),
            },
          ),
        ),
      );
    });

    const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly cwd: string;
        readonly messageText: string;
        readonly attachments?: ReadonlyArray<ChatAttachment>;
        readonly titleSeed?: string;
      }) {
        const attachments = input.attachments ?? [];
        yield* Effect.gen(function* () {
          const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
            input.threadId,
          );

          const generated = yield* textGeneration
            .generateThreadTitle({
              cwd: input.cwd,
              message: input.messageText,
              ...(attachments.length > 0 ? { attachments } : {}),
              modelSelection,
            })
            .pipe(
              Effect.retry({
                times: 2,
                schedule: Schedule.exponential("2 seconds"),
              }),
            );
          if (!generated) return;

          const thread = yield* resolveThreadShell(input.threadId);
          if (!thread) return;
          if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
            return;
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-rename"),
            threadId: input.threadId,
            title: generated.title,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "provider command reactor failed to generate or rename thread title",
              {
                threadId: input.threadId,
                cwd: input.cwd,
                cause: Cause.pretty(cause),
              },
            ),
          ),
        );
      },
    );

    const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
      requestId: CommandId,
    ) {
      if (event.payload.regenerateTitle !== true) {
        return { _tag: "Superseded" } as const;
      }

      const thread = yield* resolveThreadDetail(event.payload.threadId);
      if (!thread || thread.titleRegeneration?.requestId !== requestId) {
        return { _tag: "Superseded" } as const;
      }

      const { message, attachments } = formatThreadTitleContext(thread.messages);
      if (message.length === 0) {
        return { _tag: "Completed", title: undefined } as const;
      }

      const previousTitle = event.payload.previousTitle ?? thread.title;
      if (thread.title !== previousTitle) {
        return { _tag: "Superseded" } as const;
      }
      const project = yield* resolveProject(thread.projectId);
      const cwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
        yield* serverSettingsService.getSettings,
        thread.projectId,
      ).settings;
      const generated = yield* textGeneration.generateThreadTitle({
        cwd,
        message,
        previousTitle,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
        return { _tag: "Completed", title: undefined } as const;
      }

      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        !latestThread ||
        latestThread.titleRegeneration?.requestId !== requestId ||
        latestThread.title !== previousTitle
      ) {
        return { _tag: "Superseded" } as const;
      }

      return { _tag: "Completed", title: generated.title } as const;
    });

    const dispatchThreadTitleRegenerationCompletion = Effect.fn(
      "dispatchThreadTitleRegenerationCompletion",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly title?: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: yield* serverCommandId("thread-title-regeneration-complete"),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
    });
    const findInterruptedThreadTitleRegenerations = Effect.fn(
      "findInterruptedThreadTitleRegenerations",
    )(function* () {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      return readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      });
    });
    const clearInterruptedThreadTitleRegenerations = Effect.fn(
      "clearInterruptedThreadTitleRegenerations",
    )(function* (
      interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
    ) {
      yield* Effect.forEach(
        interrupted,
        ({ threadId, requestId }) => {
          return dispatchThreadTitleRegenerationCompletion({
            threadId,
            requestId,
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.interrupt;
              }
              return Effect.logWarning(
                "provider command reactor failed to clear interrupted title regeneration",
                {
                  threadId,
                  cause: Cause.pretty(cause),
                },
              );
            }),
          );
        },
        { discard: true },
      );
    });
    const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
      function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
        if (event.payload.regenerateTitle !== true) {
          return;
        }

        const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
        if (requestId === null) {
          return;
        }
        const result = yield* regenerateThreadTitle(event, requestId).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logWarning("provider command reactor failed to regenerate thread title", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
          }),
        );
        if (result._tag === "Superseded") {
          return;
        }

        const completion = {
          threadId: event.payload.threadId,
          requestId,
          ...(result.title !== undefined ? { title: result.title } : {}),
        };
        yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logWarning(
              "provider command reactor retrying title regeneration completion",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              },
            ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
          }),
        );
      },
      (effect, event) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logWarning(
              "provider command reactor failed to complete title regeneration",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        ),
    );
    const threadTitleRegenerationWorker = yield* makeDrainableWorker(
      processThreadTitleRegenerationSafely,
    );
    // A successful native command is an accepted delivery even when it creates no turn.
    const acknowledgeQueuedDelivery = Effect.fn("acknowledgeQueuedDelivery")(function* (
      event: QueuedTurnStart,
      turnId: TurnId | null,
    ) {
      const messageId = event.payload.queuedDeliveryMessageId;
      if (messageId == null) return;
      const consumedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.suspend(() =>
        orchestrationEngine.dispatch({
          type: "thread.turn.queue.consume",
          commandId: CommandId.make(`queued-turn-consumed:${event.payload.threadId}:${messageId}`),
          threadId: event.payload.threadId,
          messageId,
          turnId,
          createdAt: consumedAt,
        }),
      ).pipe(
        Effect.retry({
          schedule: Schedule.exponential("250 millis").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(5))),
            ),
            Schedule.jittered,
          ),
          while: (error) =>
            error._tag === "PersistenceSqlError" ||
            error._tag === "OrchestrationListenerCallbackError",
        }),
      );
    });

    // Serialize admission with cancellation, but release the permit before provider work.
    // Ownership remains until completion is persisted, preventing recovery from redelivering.
    const withNativeDelivery = <A, E, R>(
      event: QueuedTurnStart,
      operation: Effect.Effect<A, E, R>,
    ) => {
      const threadId = event.payload.threadId;
      const messageId = event.payload.queuedDeliveryMessageId;
      if (messageId == null) return operation.pipe(Effect.map(Option.some));
      return Effect.acquireUseRelease(
        delivery.withPermit(
          threadId,
          Effect.gen(function* () {
            if (yield* delivery.isPending(threadId, messageId)) return false;
            const thread = yield* resolveThreadDetail(threadId);
            if (
              thread?.session?.stopRequestedAt != null ||
              !thread?.queuedTurnStarts?.some(
                (entry) => entry.messageId === messageId && entry.releasingAt !== undefined,
              )
            )
              return false;
            yield* delivery.setPending(threadId, messageId, true);
            return true;
          }),
        ),
        (admitted) =>
          admitted ? operation.pipe(Effect.map(Option.some)) : Effect.succeed(Option.none<A>()),
        (admitted) => (admitted ? delivery.setPending(threadId, messageId, false) : Effect.void),
      );
    };

    const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
      receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    ) {
      const resumed =
        receivedEvent.commandId !== null
          ? resumedTurnStarts.get(receivedEvent.commandId)
          : undefined;
      const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
      const key = turnStartKeyForEvent(event);
      if (yield* hasHandledTurnStartRecently(key)) {
        return;
      }

      const queuedId = event.payload.queuedDeliveryMessageId;
      if (queuedId != null && (yield* delivery.isPending(event.payload.threadId, queuedId))) return;
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId: thread.id,
        messageId: event.payload.messageId,
      });
      if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.messageId,
        });
        return;
      }
      // A grace-stop deadline can land while its notice is still queued. It is
      // the notice alone that must not revive a stopped session; regular turns
      // are allowed to resume a stopped child.
      if (event.payload.graceStopNotice === true && thread.session?.status === "stopped") {
        return;
      }
      const { message, hasOtherUserMessages } = turnStart.value;
      const appendTurnStartFailure = (summary: string, detail: string) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary,
          detail,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.messageId,
        });
      if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
        return yield* appendTurnStartFailure(
          "Queued message was not sent",
          "The queued message was canceled before it could resume. Send it again to continue.",
        );
      }

      const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const detail = formatFailureDetail(cause);
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Provider turn start failed", detail)),
          Effect.asVoid,
        );
      };

      const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
        handleTurnStartFailure(cause).pipe(
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning("provider command reactor failed to recover turn start failure", {
              eventType: event.type,
              threadId: event.payload.threadId,
              cause: Cause.pretty(recoveryCause),
              originalCause: Cause.pretty(cause),
            }),
          ),
        );

      const authCommandHandled = yield* withNativeDelivery(
        event,
        Effect.gen(function* () {
          // Native account commands belong to the thread's existing provider session.
          const instanceId =
            thread.session?.providerInstanceId ??
            event.payload.modelSelection?.instanceId ??
            thread.modelSelection.instanceId;
          const handled = yield* providerAuthService.tryHandlePromptCommand({
            instanceId,
            text: message.text,
            hasAttachments: (message.attachments?.length ?? 0) > 0,
          });
          if (!handled) {
            return false;
          }

          yield* acknowledgeQueuedDelivery(event, null);
          const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
          yield* setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "stopped",
              providerName: instanceInfo.driverKind,
              providerInstanceId: instanceId,
              runtimeMode: thread.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: event.payload.createdAt,
            },
            createdAt: event.payload.createdAt,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* serverCommandId("provider-sign-out"),
            threadId: thread.id,
            activity: {
              id: yield* serverEventId(),
              tone: "info",
              kind: "provider.auth.signed-out",
              summary: "Provider signed out",
              payload: { providerInstanceId: instanceId },
              turnId: null,
              createdAt: event.payload.createdAt,
            },
            createdAt: event.payload.createdAt,
          });
          return true;
        }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true)))),
      );
      if (Option.isNone(authCommandHandled) || authCommandHandled.value) {
        return;
      }

      yield* ensureThreadWorktree(thread);

      const isCompactCommand = isCompactCommandMessage(message);
      if (!hasOtherUserMessages && !isCompactCommand) {
        const project = yield* resolveProject(thread.projectId);
        const generationCwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: project ? [project] : [],
          }) ?? process.cwd();
        const generationInput = {
          messageText: assistantCitationsToPlainText(message.text),
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        };

        yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
          threadId: event.payload.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...generationInput,
        }).pipe(Effect.forkScoped);

        if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
          yield* maybeGenerateThreadTitleForFirstTurn({
            threadId: event.payload.threadId,
            cwd: generationCwd,
            ...generationInput,
          }).pipe(Effect.forkScoped);
        }
      }

      let compactionSessionEnsured = false;
      const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const detail = formatFailureDetail(cause);
        if (!compactionSessionEnsured) {
          return setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
            Effect.asVoid,
          );
        }
        return appendTurnStartFailure("Context compaction failed", detail).pipe(
          Effect.ensuring(
            restoreCompaction(event.payload.threadId).pipe(
              Effect.catchCause((restoreCause) =>
                Effect.logWarning("failed to restore provider session after compaction failure", {
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(restoreCause),
                }),
              ),
            ),
          ),
          Effect.asVoid,
        );
      };
      const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
        handleCompactionFailure(cause).pipe(
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning("provider command reactor failed to recover compaction failure", {
              eventType: event.type,
              threadId: event.payload.threadId,
              cause: Cause.pretty(recoveryCause),
              originalCause: Cause.pretty(cause),
            }),
          ),
        );
      if (isCompactCommand) {
        if (!hasOtherUserMessages) {
          return yield* appendTurnStartFailure(
            "Context compaction failed",
            "Context compaction requires an existing conversation.",
          );
        }
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        if (
          compactingThreadIds.has(event.payload.threadId) ||
          turnsAfterCompaction.has(event.payload.threadId) ||
          latestThread?.session?.status === "starting" ||
          latestThread?.session?.status === "running"
        ) {
          yield* appendTurnStartFailure(
            "Context compaction failed",
            "Context compaction is unavailable while a provider turn is running.",
          );
          return;
        }
        compactingThreadIds.add(event.payload.threadId);
        const clearCompacting = Effect.sync(
          () => void compactingThreadIds.delete(event.payload.threadId),
        );
        yield* withNativeDelivery(
          event,
          Effect.gen(function* () {
            yield* ensureSessionForThread(
              event.payload.threadId,
              event.payload.createdAt,
              event.payload.modelSelection !== undefined
                ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
                : { pendingTurnStart: true },
            );
            compactionSessionEnsured = true;
            if (event.payload.modelSelection !== undefined) {
              threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
            }
            yield* providerService.compactThread(
              event.payload.threadId,
              event.payload.modelSelection,
              event.payload.messageId,
            );
            yield* acknowledgeQueuedDelivery(event, null);
          }),
        ).pipe(
          Effect.flatMap((admitted) =>
            Option.isSome(admitted) ? restoreCompaction(event.payload.threadId, true) : Effect.void,
          ),
          Effect.andThen(clearCompacting),
          Effect.andThen(resumeTurnsAfterCompaction(event.payload.threadId)),
          Effect.catchCause((cause) =>
            recoverCompactionFailure(cause).pipe(
              Effect.ensuring(clearCompacting),
              Effect.andThen(
                cancelTurnsAfterCompaction(
                  event.payload.threadId,
                  "Context compaction failed. Send this message again to continue.",
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        return;
      }
      if (
        !resumed &&
        (compactingThreadIds.has(event.payload.threadId) ||
          turnsAfterCompaction.has(event.payload.threadId))
      ) {
        const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
        queued.push(event);
        turnsAfterCompaction.set(event.payload.threadId, queued);
        return;
      }
      const sendTurnRequest = yield* buildSendTurnRequestForThread({
        threadId: event.payload.threadId,
        messageText: projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        interactionMode: event.payload.interactionMode,
        // New sends acknowledge the adapter result, not an unrelated lifecycle event.
        queuedDeliveryMessageId: null,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
      );

      if (Option.isNone(sendTurnRequest)) {
        return;
      }

      // The forked send settles `sent` from here on, so drop the entry the post-processing hook uses.
      if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
      yield* Effect.gen(function* () {
        const messageId = event.payload.queuedDeliveryMessageId;
        if (messageId != null) {
          const current = yield* resolveThreadDetail(event.payload.threadId);
          if (current?.session?.stopRequestedAt != null) return;
          if (
            !current?.queuedTurnStarts?.some(
              (entry) => entry.messageId === messageId && entry.releasingAt !== undefined,
            )
          )
            return;
        }
        if (messageId != null) {
          if (yield* delivery.isPending(event.payload.threadId, messageId)) return;
          yield* delivery.setPending(event.payload.threadId, messageId, true);
        }
        // The permit serializes admission with cancellation, never provider work.
        // A cancelled in-flight attempt can still receive a late acceptance receipt.
        yield* Effect.gen(function* () {
          const accepted = yield* providerService.sendTurn(sendTurnRequest.value).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              recoverTurnStartFailure(cause).pipe(Effect.as(Option.none())),
            ),
          );
          if (Option.isNone(accepted) || messageId == null) return;
          yield* acknowledgeQueuedDelivery(event, accepted.value.turnId);
        }).pipe(
          Effect.ensuring(
            Effect.all([
              messageId == null
                ? Effect.void
                : delivery.setPending(event.payload.threadId, messageId, false),
              resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void,
            ]),
          ),
          Effect.forkScoped,
        );
      }).pipe((send) =>
        event.payload.queuedDeliveryMessageId == null
          ? send
          : delivery.withPermit(event.payload.threadId, send),
      );
    });
    const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
    ) {
      yield* cancelTurnsAfterCompaction(
        event.payload.threadId,
        "Context compaction was interrupted. Send this message again to continue.",
      );
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail: "No active provider session is bound to this thread.",
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      }

      // Orchestration turn ids are not provider turn ids, so interrupt by session.
      // A stop that cannot reach its provider has to say so: without this the
      // press is indistinguishable from one that worked. The call is bounded:
      // a wedged transport must not jam the reactor's single worker behind
      // every later command — exactly during a runaway turn Stop matters most.
      type InterruptOutcome = "settled" | "timed-out" | "phantom" | "failed";
      const outcome: InterruptOutcome = yield* providerService
        .interruptTurn({ threadId: event.payload.threadId })
        .pipe(
          Effect.timeoutOption(`${interruptTimeoutSeconds} seconds`),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.interrupt.failed",
                  summary: "Provider turn interrupt failed",
                  detail: `Provider did not acknowledge the interrupt within ${interruptTimeoutSeconds} seconds.`,
                  turnId: event.payload.turnId ?? null,
                  createdAt: event.payload.createdAt,
                }).pipe(Effect.as("timed-out" as const)),
              onSome: () => Effect.succeed("settled" as const),
            }),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            const orphaned = hasProviderAdapterSessionNotFoundError(cause);
            const unconfirmedProcess = cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && isProviderAdapterProcessError(reason.error),
            );
            return appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: Cause.pretty(cause),
              turnId: event.payload.turnId ?? null,
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.as(
                orphaned
                  ? ("phantom" as const)
                  : unconfirmedProcess
                    ? ("timed-out" as const)
                    : ("failed" as const),
              ),
            );
          }),
        );

      // An acknowledged stop must settle in the orchestrator. Adapters only emit
      // lifecycle events when they still know the provider turn id — after a
      // server restart (or any recovered session) they cannot, and with no
      // lifecycle event the session stays "running" forever, stranding queued
      // messages. Settle on success and for phantom sessions whose runtime died
      // with a previous process. A timeout does not prove teardown finished;
      // the queued interrupt deadline handles escalation without releasing work.
      //
      // A definite failure keeps the session running: the provider is alive and
      // may still be working, so claiming it idle — or stopped — would invite
      // the next message to interleave with live work. Upstream escalates to a
      // session stop here instead; see docs/operations/upstream-integrations.
      if (outcome === "timed-out") {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`interrupt-timeout-stop:${event.eventId}`),
          threadId: event.payload.threadId,
          onlyIfActiveTurnId: thread.session?.activeTurnId ?? null,
          onlyIfSessionEpisode: thread.session?.episodeStartedAt ?? null,
          stoppedBy: "system",
          stopReason: "tool_failed",
          createdAt: event.payload.createdAt,
        });
        return;
      }
      if (outcome === "failed") {
        return;
      }
      const phantom = outcome === "phantom";
      const afterInterrupt = yield* resolveThreadShell(event.payload.threadId);
      const activeTurnId = afterInterrupt?.session?.activeTurnId ?? null;
      if (
        activeTurnId !== (thread.session?.activeTurnId ?? null) ||
        (afterInterrupt?.session?.episodeStartedAt ?? null) !==
          (thread.session?.episodeStartedAt ?? null)
      )
        return;
      if (
        afterInterrupt?.session &&
        activeTurnId !== null &&
        (afterInterrupt.session.status === "starting" ||
          afterInterrupt.session.status === "running")
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.set",
            commandId: yield* serverCommandId("provider-interrupt-settle"),
            threadId: event.payload.threadId,
            onlyIfActiveTurnId: activeTurnId,
            session: {
              ...afterInterrupt.session,
              status: phantom ? "error" : "ready",
              activeTurnId: null,
              ...(phantom
                ? {
                    lastError:
                      "The provider session for this thread is gone; the active turn was stopped. Send a new message to continue.",
                    stoppedBy: "system" as const,
                    stopReason: "provider_crashed" as const,
                  }
                : {}),
              updatedAt: event.payload.createdAt,
            },
            createdAt: event.payload.createdAt,
          })
          .pipe(
            // The guard denies benignly when ingestion settled the turn first.
            Effect.catchCause((cause) =>
              Effect.logDebug("provider interrupt settle skipped", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    });
    const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(
      function* (
        event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
      ) {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread) {
          return;
        }
        const hasSession = thread.session && thread.session.status !== "stopped";
        if (!hasSession) {
          // The provider callback state is gone with the session, so this request
          // can never be answered. Say so in stale-request terms: the projection
          // pipeline resolves the pending-approval row on this detail, which also
          // unblocks settling the thread.
          return yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: `No active provider session is bound to this thread. ${stalePendingRequestDetail("approval", event.payload.requestId)}`,
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          });
        }

        yield* providerService
          .respondToRequest({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            decision: event.payload.decision,
          })
          .pipe(
            Effect.catchCause((cause) =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.approval.respond.failed",
                summary: "Provider approval response failed",
                detail: isUnknownPendingApprovalRequestError(cause)
                  ? stalePendingRequestDetail("approval", event.payload.requestId)
                  : Cause.pretty(cause),
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              }),
            ),
          );
      },
    );
    const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
      function* (
        event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
      ) {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread) {
          return;
        }
        const hasSession = thread.session && thread.session.status !== "stopped";
        if (!hasSession) {
          // Same stale-request semantics as approvals above: the projection
          // resolves the pending user-input row on this detail.
          return yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: `No active provider session is bound to this thread. ${stalePendingRequestDetail("user-input", event.payload.requestId)}`,
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          });
        }

        yield* providerService
          .respondToUserInput({
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            answers: event.payload.answers,
            ...(event.payload.attachmentsByQuestionId
              ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
              : {}),
          })
          .pipe(
            Effect.catchCause((cause) =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.user-input.respond.failed",
                summary: "Provider user input response failed",
                detail: isUnknownPendingUserInputRequestError(cause)
                  ? stalePendingRequestDetail("user-input", event.payload.requestId)
                  : Cause.pretty(cause),
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              }),
            ),
          );
      },
    );
    const stopGraceEpisodeAtDeadline = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly episodeId: EventId;
    }) {
      const current = yield* resolveThreadShell(input.threadId);
      if (
        !current?.session ||
        current.session.status === "stopped" ||
        current.session.graceStopEpisodeId !== input.episodeId
      ) {
        return;
      }
      yield* providerService.stopSession({ threadId: current.id });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* setThreadSession({
        threadId: current.id,
        session: {
          ...current.session,
          status: "stopped",
          activeTurnId: null,
          graceStopDeadlineAt: null,
          graceStopEpisodeId: null,
          updatedAt: now,
        },
        createdAt: now,
      });
    });

    const armGraceStopDeadline = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly episodeId: EventId;
      readonly deadlineAt: string;
    }) {
      const key = `${input.threadId}:${input.episodeId}`;
      if (armedGraceStopEpisodes.has(key)) {
        return;
      }
      const deadlineMs = Date.parse(input.deadlineAt);
      if (Number.isNaN(deadlineMs)) {
        yield* Effect.logWarning("provider command reactor invalid graceful stop deadline", input);
        return;
      }
      armedGraceStopEpisodes.add(key);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(Math.max(0, deadlineMs - now))).pipe(
        Effect.andThen(stopGraceEpisodeAtDeadline(input)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor graceful stop deadline failed", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.ensuring(Effect.sync(() => armedGraceStopEpisodes.delete(key))),
        Effect.forkScoped,
        Effect.asVoid,
      );
    });

    const rearmGraceStopDeadlines = Effect.fn("rearmGraceStopDeadlines")(function* () {
      const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
      for (const thread of snapshot.threads) {
        if (
          thread.session?.status !== "stopped" &&
          thread.session?.graceStopDeadlineAt != null &&
          thread.session.graceStopEpisodeId != null
        ) {
          yield* armGraceStopDeadline({
            threadId: thread.id,
            episodeId: thread.session.graceStopEpisodeId,
            deadlineAt: thread.session.graceStopDeadlineAt,
          });
        }
      }
    });

    const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
      event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
    ) {
      const thread = yield* resolveThreadStopContext(event.payload.threadId);
      if (!thread) {
        return;
      }

      const now = event.payload.createdAt;
      const wasCompacting = compactingThreadIds.has(thread.id);
      stoppingThreadIds.add(thread.id);
      const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
      yield* cancelTurnsAfterCompaction(
        thread.id,
        "The session was stopped during context compaction. Send this message again to continue.",
      );
      const stopAudit = (current: typeof thread) => {
        return {
          stoppedBy: event.payload.stoppedBy ?? "user",
          stopRequestedAt: event.payload.createdAt,
          stopReason: event.payload.stopReason ?? "user_stopped",
          interruptedToolCall:
            current.session?.activeTurnId !== undefined &&
            current.session.activeTurnId !== null &&
            current.lastToolKind === "tool.started",
          lastCompletedOperation: current.lastCompletedOperation,
        } as const;
      };
      const setStoppedSession = (current: typeof thread) =>
        setThreadSession({
          threadId: current.id,
          session: {
            threadId: current.id,
            status: "stopped",
            providerName: current.session?.providerName ?? null,
            ...(current.session?.providerInstanceId !== undefined
              ? { providerInstanceId: current.session.providerInstanceId }
              : {}),
            runtimeMode: current.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            episodeStartedAt: current.session?.episodeStartedAt ?? null,
            lastError: current.session?.lastError ?? null,
            ...stopAudit(current),
            graceStopDeadlineAt: null,
            graceStopEpisodeId: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      const hardStop = Effect.fnUntraced(function* () {
        const current = yield* resolveThreadStopContext(event.payload.threadId);
        if (!current || current.session?.status === "stopped") {
          return;
        }
        if (
          (event.payload.onlyIfActiveTurnId !== undefined &&
            current.session?.activeTurnId !== event.payload.onlyIfActiveTurnId) ||
          (event.payload.onlyIfSessionEpisode !== undefined &&
            (current.session?.episodeStartedAt ?? null) !== event.payload.onlyIfSessionEpisode)
        )
          return;
        if (current.session !== null) {
          yield* setThreadSession({
            threadId: current.id,
            session: { ...current.session, ...stopAudit(current) },
            createdAt: now,
          });
          yield* providerService.stopSession({ threadId: current.id });
        }
        const afterStop = yield* resolveThreadStopContext(current.id);
        if (
          !afterStop ||
          (afterStop.session?.episodeStartedAt ?? null) !==
            (current.session?.episodeStartedAt ?? null)
        )
          return;
        yield* setStoppedSession(afterStop);
      });

      yield* Effect.gen(function* () {
        if (event.payload.gracePeriodMs == null || thread.session === null) {
          return yield* hardStop();
        }

        if (
          thread.session.graceStopDeadlineAt != null &&
          thread.session.graceStopEpisodeId != null
        ) {
          // Multiple stop commands should not make the provider process several
          // notices or replace the first deadline. Re-arm in case this reactor
          // restarted after the deadline was recorded.
          return yield* armGraceStopDeadline({
            threadId: thread.id,
            episodeId: thread.session.graceStopEpisodeId,
            deadlineAt: thread.session.graceStopDeadlineAt,
          });
        }

        const episodeId = event.eventId;
        const deadlineAt = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(now), { milliseconds: event.payload.gracePeriodMs }),
        );

        // Provider adapters treat a send while a real turn is running as a steer,
        // so this notice is queued after the in-flight tool work instead of
        // cancelling it. The child can then use post_report before the deadline.
        yield* setThreadSession({
          threadId: thread.id,
          session: {
            ...thread.session,
            ...stopAudit(thread),
            graceStopDeadlineAt: deadlineAt,
            graceStopEpisodeId: episodeId,
            updatedAt: now,
          },
          createdAt: now,
        });
        // Arm before dispatching so a delivery failure cannot leave the child
        // running indefinitely. The persisted deadline is re-armed at startup.
        yield* armGraceStopDeadline({ threadId: thread.id, episodeId, deadlineAt });
        const noticeMessageId = MessageId.make(yield* crypto.randomUUIDv4);
        const partialReportInstruction =
          event.payload.requestPartialReport === true
            ? " Call post_report with a partial report before stopping."
            : " Stop after completing the current operation.";
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* serverCommandId("session-graceful-stop-notice"),
          threadId: thread.id,
          message: {
            messageId: noticeMessageId,
            role: "user",
            text: `A parent session requested that you stop. Finish the current tool call if one is in progress, then stop working.${partialReportInstruction}`,
            attachments: [],
            // Phoenix relaying the parent's stop request — not the human, and
            // not the parent speaking in its own words.
            origin: { kind: "phoenix", threadId: thread.spawnedByThreadId ?? null },
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          graceStopNotice: true,
          createdAt: now,
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* clearStopping;
            // Compaction may settle while provider stop is still pending. Restore
            // its transient state on either outcome, preserving stopped/running.
            if (wasCompacting && !compactingThreadIds.has(thread.id)) {
              yield* restoreCompaction(thread.id).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to restore provider session after compaction", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
            }
          }),
        ),
      );
    });
    const processDomainEvent = Effect.fn("processDomainEvent")(function* (
      event: ProviderIntentEvent,
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration.event_type": event.type,
        "orchestration.thread_id": event.payload.threadId,
        ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
      });
      yield* increment(orchestrationEventsProcessedTotal, {
        eventType: event.type,
      });
      switch (event.type) {
        case "thread.meta-updated":
          yield* threadTitleRegenerationWorker.enqueue(event);
          return;
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThreadShell(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
          yield* ensureSessionForThread(
            event.payload.threadId,
            event.occurredAt,
            cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
          );
          return;
        }
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const current = yield* resolveThreadShell(event.payload.threadId);
                const detail = Cause.pretty(cause);
                if (current?.session)
                  yield* setThreadSession({
                    threadId: current.id,
                    session: {
                      ...current.session,
                      lastError: `Provider stop was not confirmed: ${detail}`,
                    },
                    createdAt: event.payload.createdAt,
                  });
                yield* appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.session.stop.failed",
                  summary: "Provider stop was not confirmed",
                  detail,
                  turnId: null,
                  createdAt: event.payload.createdAt,
                });
              }),
            ),
          );
          return;
        case "thread.settled": {
          const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
          if (
            Option.isNone(thread) ||
            thread.value.session == null ||
            thread.value.session.status === "stopped"
          ) {
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(
              `session-stop-for-settle:${event.commandId ?? event.eventId}`,
            ),
            threadId: event.payload.threadId,
            createdAt: event.occurredAt,
            onlyIfSettled: true,
          });
          return;
        }
        case "thread.migrated": {
          // The decider has already validated the migration (no running turn,
          // target differs) and the projector has rebound thread.modelSelection.
          // Keep the reactor's per-thread selection cache in step so unrelated
          // restarts (e.g. runtime-mode changes) do not resurrect the old account.
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          const thread = yield* resolveThreadShell(event.payload.threadId);
          if (!thread?.session) {
            // Never started: the first turn starts on the target instance via
            // the rebound thread.modelSelection, seeded if history exists.
            return;
          }
          // A stopped session migrates too — otherwise the stale binding would
          // trip the instance guard on the next turn.
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            modelSelection: event.payload.modelSelection,
            allowMigration: true,
            ...(event.payload.brief !== undefined ? { migrationBrief: event.payload.brief } : {}),
          });
          // Auto-failover retries the failed turn here, after the rebind, so the
          // retry can never race the session restart into the instance guard.
          if (event.payload.trigger === "auto-failover") {
            const migrated = yield* resolveThreadDetail(event.payload.threadId);
            const failedMessage = migrated?.messages.findLast((message) => message.role === "user");
            if (migrated && failedMessage) {
              // Same message id: the projection upserts on message_id, so the
              // retried turn replaces the failed one instead of duplicating it.
              yield* orchestrationEngine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`limit-failover-retry:${event.eventId}`),
                threadId: event.payload.threadId,
                message: {
                  messageId: failedMessage.id,
                  role: "user",
                  text: failedMessage.text,
                  attachments: failedMessage.attachments ?? [],
                },
                interactionMode: migrated.interactionMode,
                runtimeMode: migrated.runtimeMode,
                createdAt: event.occurredAt,
              });
            }
          }
          return;
        }
      }
    });

    const processDomainEventSafely = (event: ProviderIntentEvent) =>
      processDomainEvent(event).pipe(
        // A replay that returned before forking its send still holds its entry; settle it so
        // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
        Effect.ensuring(
          Effect.suspend(() => {
            const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
            return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning("provider command reactor failed to process event", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          });
        }),
      );

    const worker = yield* QueuedDelivery.makeWorker(
      (event: ProviderIntentEvent) => event.payload.threadId,
      processDomainEventSafely,
    );

    const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
      yield* rearmGraceStopDeadlines().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to re-arm graceful stop deadlines", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning(
            "provider command reactor failed to find interrupted title regenerations",
            { cause: Cause.pretty(cause) },
          ).pipe(Effect.as([]));
        }),
      );
      const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
        if (
          (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
          event.type === "thread.runtime-mode-set" ||
          event.type === "thread.turn-start-requested" ||
          event.type === "thread.turn-interrupt-requested" ||
          event.type === "thread.approval-response-requested" ||
          event.type === "thread.user-input-response-requested" ||
          event.type === "thread.session-stop-requested" ||
          event.type === "thread.settled" ||
          event.type === "thread.migrated"
        ) {
          return yield* worker.enqueue(event);
        }
      });

      // Subscribe before returning, even while event handling waits for server activation.
      const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
      yield* forkParked(Stream.runForEach(domainEvents, processEvent));

      // The domain event stream is hot, so work pending before this reactor
      // starts cannot be resumed. Correlated completions only clear the request
      // captured here, leaving any newer request untouched.
      const clearInterrupted = clearInterruptedThreadTitleRegenerations(
        interruptedTitleRegenerations,
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.logWarning(
            "provider command reactor failed to clear interrupted title regenerations",
            {
              cause: Cause.pretty(cause),
            },
          );
        }),
      );
      const activation = yield* ServerActivation;
      if (activation === undefined) {
        yield* clearInterrupted;
      } else {
        yield* forkParked(clearInterrupted);
      }
    });

    return {
      start,
      drain: Effect.gen(function* () {
        yield* worker.drain;
        yield* threadTitleRegenerationWorker.drain;
      }),
    } satisfies ProviderCommandReactorShape;
  });

export const makeProviderCommandReactorLive = (options?: {
  readonly interruptTimeoutSeconds?: number;
}) => Layer.effect(ProviderCommandReactor, make(options));
export const ProviderCommandReactorLive = makeProviderCommandReactorLive();
