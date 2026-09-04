import {
  CommandId,
  DEFAULT_SESSION_REPORT_DELIVERY,
  deriveSessionExitReason,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type OrchestrationMessageOrigin,
  type OrchestrationThreadShell,
  type SessionExitReason,
  type SessionReport,
  type SessionReportNotificationActivity,
  type SessionReportStatus,
  ThreadId,
  toSessionReportEnvelope,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";

import { forkParked } from "../../serverActivation.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveSessionUsageSnapshot } from "../sessionUsage.ts";
import {
  SessionSpawnReactor,
  type SessionSpawnReactorShape,
} from "../Services/SessionSpawnReactor.ts";

type ReportPostedEvent = Extract<OrchestrationEvent, { type: "thread.report-posted" }>;
type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type TurnQueuedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-queued" }>;
type TurnRequestedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type WatchedEvent = ReportPostedEvent | SessionSetEvent | TurnQueuedEvent | TurnRequestedEvent;
type WorkerInput =
  | { readonly type: "event"; readonly event: WatchedEvent }
  | { readonly type: "recover"; readonly threadId: ThreadId }
  | {
      readonly type: "interrupt-timeout";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    };
type DeathNoticeInput = {
  readonly threadId: ThreadId;
  readonly shell: OrchestrationThreadShell;
  readonly exitReason: SessionExitReason;
  readonly lastError: string | null;
  readonly synthesizedReportId: string | null;
  readonly hadAgentReport: boolean;
  readonly episodeKey: string;
};

// A session in one of these states is done producing work for this episode.
// "interrupted" is deliberately absent: an interrupt parks a turn, the session
// stays alive, and the agent may still report on the next one.
const TERMINAL_SESSION_STATUSES = new Set<OrchestrationSessionStatus>(["stopped", "error"]);

// A type predicate, not just a boolean: the queue-cancellation path it guards
// only accepts the terminal statuses.
const isTerminalStatus = (status: OrchestrationSessionStatus): status is "stopped" | "error" =>
  TERMINAL_SESSION_STATUSES.has(status);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const INTERRUPT_FALLBACK_TIMEOUT = Duration.seconds(30);
const RECOVERY_INTERVAL = Duration.seconds(30);
const RELEASING_RECOVERY_AGE = Duration.seconds(30);
const LIVE_RELEASING_MAX_AGE = Duration.minutes(2);
const MAX_QUEUED_TURN_REDELIVERIES = 3;

const truncate = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const SESSION_REPORT_DELIVERY_MESSAGE_PREFIX = "session-report-delivery:";

/**
 * Recovers the child/report identity from a report-delivery message id
 * (`session-report-delivery:<childThreadId>:<reportId>`, minted in the
 * report branch below). Both ids are server-generated UUIDs, so the first
 * two colons are unambiguous separators.
 */
export const parseReportDeliveryMessageId = (
  messageId: string,
): { readonly childThreadId: string; readonly reportId: string } | null => {
  if (!messageId.startsWith(SESSION_REPORT_DELIVERY_MESSAGE_PREFIX)) return null;
  const rest = messageId.slice(SESSION_REPORT_DELIVERY_MESSAGE_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { childThreadId: rest.slice(0, separator), reportId: rest.slice(separator + 1) };
};

export const formatReportMessage = (childTitle: string, report: SessionReport): string => {
  const envelope = toSessionReportEnvelope(report);
  const artifactLines =
    report.artifacts.length === 0
      ? ""
      : `\n\nArtifacts:\n${report.artifacts
          .map((artifact) =>
            artifact.label
              ? `- ${artifact.kind}: ${artifact.value} (${artifact.label})`
              : `- ${artifact.kind}: ${artifact.value}`,
          )
          .join("\n")}`;
  // An amendment leads with the fact that it replaces an earlier report: a
  // parent that already acted on the superseded one has to see that first,
  // before it reads a summary it thinks it has seen.
  const amendment =
    report.supersedesReportId !== undefined
      ? `AMENDED report (supersedes ${report.supersedesReportId}). `
      : "";
  // A synthesized report must never read as if the child wrote it: the parent
  // decides what to do next based on who is claiming the work is over.
  const lead =
    report.origin === "system"
      ? `[Phoenix] ${amendment}Spawned session "${childTitle}" ended without posting a report. Phoenix generated a ${report.status} report for it: ${report.title}`
      : `[Phoenix] ${amendment}Spawned session "${childTitle}" posted a ${report.status} report: ${report.title}`;
  // Reports at or under the inline threshold are delivered whole — agent and
  // system reports alike. Larger ones become a compact envelope: abstract
  // plus addressing, with the body (and full findings/validation) behind
  // read_report, so a burst of child reports cannot flood this parent.
  if (!envelope.truncated) {
    return `${lead}\n\n${report.summary}${artifactLines}\n\n(spawned thread: ${report.threadId})`;
  }
  const structuredLine =
    envelope.findingsCount > 0 || envelope.validationGapsCount > 0
      ? `\nStructured: ${envelope.findingsCount} finding${envelope.findingsCount === 1 ? "" : "s"}, ${envelope.validationGapsCount} validation gap${envelope.validationGapsCount === 1 ? "" : "s"}.`
      : "";
  const recommendationLine =
    envelope.recommendation !== undefined ? `\nRecommendation: ${envelope.recommendation}` : "";
  return `${lead}\n\nAbstract:\n${envelope.abstract}\n${recommendationLine}${structuredLine}\n[Full report is ${envelope.summaryChars} chars; this is a compact envelope. Call read_report with reportId "${report.reportId}" to read the rest.]${artifactLines}\n\n(spawned thread: ${report.threadId}, report: ${report.reportId})`;
};

export const reportNotificationActivity = (input: {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly report: SessionReport;
  readonly notifiedAt: string;
}): SessionReportNotificationActivity => {
  const { report } = input;
  const amendment = report.supersedesReportId
    ? `Amended report (supersedes ${report.supersedesReportId})`
    : "Report";
  const source = report.origin === "system" ? "Phoenix generated" : "Child posted";
  return {
    // The report ID is immutable; this makes replay/restart delivery exactly
    // once at the projection boundary as well as at the command receipt.
    id: EventId.make(
      `session-report-notification:${input.parentThreadId}:${input.childThreadId}:${report.reportId}`,
    ),
    tone: report.status === "failure" ? "error" : "info",
    kind: "session-report.posted",
    summary: `${source} ${amendment}: ${input.childTitle} — ${report.title}`,
    payload: {
      childThreadId: input.childThreadId,
      childTitle: input.childTitle,
      reportId: report.reportId,
      reportTitle: report.title,
      status: report.status,
      origin: report.origin,
      ...(report.supersedesReportId ? { supersedesReportId: report.supersedesReportId } : {}),
      createdAt: report.createdAt,
    },
    turnId: null,
    // This is when the parent learned about the report, not when the child
    // wrote it. The report's own timestamp remains in payload.createdAt.
    createdAt: input.notifiedAt,
  };
};

export const formatQueuedReportWarning = (messageIds: ReadonlyArray<MessageId>): string =>
  messageIds.length === 0
    ? ""
    : `\n\n[Phoenix] ${messageIds.length} queued message${messageIds.length === 1 ? "" : "s"} were not consumed before this report was written: ${messageIds.join(", ")}.`;

const EXIT_REASON_DESCRIPTIONS: Record<SessionExitReason, string> = {
  usage_limit: "the provider subscription hit its usage limit",
  provider_crashed: "the provider process crashed or disappeared",
  stopped_by_user: "a user stopped it",
  stopped_by_parent: "its parent session stopped it",
  permission_denied: "it was stopped after a permission was denied",
  tool_failed: "it was stopped after a tool failure",
  provider_error: "the provider reported an error",
  exited: "its provider process exited without a recorded cause",
};

/**
 * Best-effort git accounting attached to a death notice. Null counts mean
 * the worktree could not be inspected in time, which is itself worth
 * telling the parent — "unknown" and "clean" must not read the same.
 */
export interface TerminalWorktreeRisk {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly dirtyFileCount: number | null;
  readonly unpushedCommitCount: number | null;
}

/**
 * The message a parent receives when a spawned child's session terminates.
 *
 * Always delivered, unlike a report: a report is the child's (or Phoenix's
 * substitute) account of the WORK, opt-out-able via reportDelivery, while
 * this is the fact of the DEATH — exit reason, what the worktree holds, and
 * where the durable account lives. A parent that opted out of report wakes
 * still needs to know its child is gone; silence here is how work gets lost.
 */
export const formatDeathNotice = (input: {
  readonly childTitle: string;
  readonly childThreadId: ThreadId;
  readonly exitReason: SessionExitReason;
  readonly lastError: string | null;
  readonly worktree: TerminalWorktreeRisk | null;
  readonly synthesizedReportId: string | null;
  readonly hadAgentReport: boolean;
}): string => {
  const lines: Array<string> = [
    `[Phoenix] Spawned session "${input.childTitle}" terminated — exit reason: ${input.exitReason} (${EXIT_REASON_DESCRIPTIONS[input.exitReason]}).`,
  ];
  if (input.lastError !== null) {
    lines.push(`Provider error: ${truncate(input.lastError, 400)}`);
  }
  if (input.worktree !== null) {
    const { worktreePath, branch, dirtyFileCount, unpushedCommitCount } = input.worktree;
    const at = `${worktreePath}${branch !== null ? ` (branch ${branch})` : ""}`;
    if (dirtyFileCount === null || unpushedCommitCount === null) {
      lines.push(
        `Its worktree at ${at} could not be inspected; check it for uncommitted work before discarding anything.`,
      );
    } else if (dirtyFileCount > 0 || unpushedCommitCount > 0) {
      lines.push(
        `Its worktree holds ${dirtyFileCount} uncommitted file${dirtyFileCount === 1 ? "" : "s"} and ${unpushedCommitCount} unpushed commit${unpushedCommitCount === 1 ? "" : "s"} at ${at} — that work exists nowhere else; recover it before archiving.`,
      );
    } else {
      lines.push(`Its worktree at ${at} is clean: nothing uncommitted or unpushed.`);
    }
  }
  if (input.hadAgentReport) {
    lines.push(
      "It had already posted a report; treat that report as its account of the work and this notice as the record of how the session ended.",
    );
  } else if (input.synthesizedReportId !== null) {
    lines.push(
      `It never posted a report; Phoenix generated one from its final state (reportId "${input.synthesizedReportId}") — call read_report for the details.`,
    );
  } else {
    lines.push("It never posted a report.");
  }
  if (input.exitReason === "usage_limit") {
    lines.push(
      "Its provider account is exhausted: resuming this session will fail until the quota resets. To continue the work, spawn a fresh session on a different provider instance (list_session_providers shows availability).",
    );
  }
  lines.push(
    `The thread and its history remain: read_session to inspect, send_to_session to resume it, settle_session/archive_session to reclaim it.\n\n(spawned thread: ${input.childThreadId})`,
  );
  return lines.join("\n\n");
};

// A stop is an external decision with unknown progress ("partial"); a provider
// error is the session failing outright ("failure").
export const terminalReportStatus = (status: OrchestrationSessionStatus): SessionReportStatus =>
  status === "stopped" ? "partial" : "failure";

export const terminalReportTitle = (status: OrchestrationSessionStatus) =>
  status === "stopped" ? "Session stopped before reporting" : "Session failed before reporting";

/**
 * Build the body of a synthesized terminal report.
 *
 * The parent gets the three things it cannot recover on its own once the
 * session is gone: why it ended, what it was last doing, and an explicit
 * warning that the work is probably unfinished.
 */
export const buildTerminalReportSummary = (input: {
  readonly sessionStatus: OrchestrationSessionStatus;
  readonly exitReason: SessionExitReason;
  readonly lastError: string | null;
  // Stop auditing records who asked, why, and what the child was in the middle
  // of — exactly the context the parent cannot reconstruct once the session is
  // gone, so the synthesized report repeats it rather than paraphrasing.
  readonly session?: Pick<
    OrchestrationSession,
    "stopReason" | "stoppedBy" | "interruptedToolCall" | "lastCompletedOperation"
  >;
  readonly detail: Option.Option<OrchestrationThread>;
}): string => {
  const attribution =
    input.session?.stoppedBy == null
      ? ""
      : ` (stopped by ${input.session.stoppedBy}${
          input.session.stopReason ? `, reason: ${input.session.stopReason}` : ""
        })`;
  const termination =
    input.sessionStatus === "stopped"
      ? `The session was stopped before it posted a report${attribution}.`
      : `The session hit a provider error before it posted a report${
          input.lastError ? `: ${input.lastError}` : "."
        }`;

  const thread = Option.getOrUndefined(input.detail);
  const lastAssistantMessage = thread?.messages.findLast((message) => message.role === "assistant");
  const lastActivity = thread?.activities.at(-1);

  const lines = [
    "_This report was generated by Phoenix, not by the session's agent._",
    "",
    termination,
    "",
    `Exit reason: \`${input.exitReason}\` (${EXIT_REASON_DESCRIPTIONS[input.exitReason]}).`,
    // A tool call cut off mid-flight is the case most likely to have left the
    // working tree in a half-written state, so it is called out rather than
    // buried in the activity line.
    ...(input.session?.interruptedToolCall === true
      ? ["", "**A tool call was interrupted mid-execution**, so its effects may be incomplete."]
      : []),
    "",
    "**Last activity**",
    input.session?.lastCompletedOperation
      ? `- Last completed operation: ${truncate(input.session.lastCompletedOperation, 400)}`
      : "- No completed operation was recorded.",
    lastActivity
      ? `- ${lastActivity.kind}: ${truncate(lastActivity.summary, 400)}`
      : "- No recorded tool activity.",
    lastAssistantMessage
      ? `- Last assistant message: ${truncate(lastAssistantMessage.text.replace(/\s+/g, " ").trim(), 800)}`
      : "- No assistant message was produced.",
    "",
    "**Work is likely unfinished.** Nothing here was verified by the agent. Use `read_session` to inspect the thread's history before relying on any of it, and re-spawn or re-assign the work if it still needs doing.",
  ];
  return truncate(lines.join("\n"), 16_384);
};

export const makeSessionSpawnReactor = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerService = yield* ProviderService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  // A session can bounce through terminal states repeatedly (retries,
  // restarts). Synthesize at most one terminal report per episode; a later
  // healthy state re-arms.
  const terminalReportedThreads = new Map<string, string>();
  const releaseNextQueuedTurn = Effect.fn("SessionSpawnReactor.releaseNextQueuedTurn")(function* (
    threadId: ThreadId,
  ) {
    const queued = (yield* projectionTurnRepository.listQueuedTurnStarts).find(
      (entry) => entry.threadId === threadId && entry.state === "queued",
    );
    if (queued === undefined) return;
    yield* engine.dispatch({
      type: "thread.turn.start.queued",
      commandId: yield* serverCommandId("queued-turn-start"),
      threadId,
      messageId: queued.messageId,
      createdAt: yield* nowIso,
    });
  });

  const cancelQueuedTurns = Effect.fn("SessionSpawnReactor.cancelQueuedTurns")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason:
      | "session_terminal"
      | "interrupt_timeout"
      | "redelivery_limit_reached"
      | "delivery_stalled"
      | "legacy_report_notification";
  }) {
    // A terminal session cancels everything still owed to it, including a
    // delivery caught mid-release: the repository's cancel transition accepts
    // releasing rows, and leaving one behind pins the stalled count and the
    // client's queued marker forever. (Interrupt-mode rows surface here as
    // "interrupting" until the replacement turn is accepted.)
    const queued = (yield* projectionTurnRepository.listQueuedTurnStarts).filter(
      (entry) =>
        entry.threadId === input.threadId &&
        (entry.state === "queued" || entry.state === "interrupting" || entry.state === "releasing"),
    );
    yield* Effect.forEach(
      queued,
      (entry) =>
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.turn.queue.cancel",
            commandId: yield* serverCommandId("queued-turn-cancel"),
            threadId: input.threadId,
            messageId: entry.messageId,
            reason: input.reason,
            createdAt: yield* nowIso,
          });
        }),
      { concurrency: 1 },
    );
    return queued.length;
  });

  const wedgedThreadsNotified = new Set<string>();
  const cancelWedgedDelivery = Effect.fn("SessionSpawnReactor.cancelWedgedDelivery")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly reason: "redelivery_limit_reached" | "delivery_stalled";
      readonly redeliveryCount: number;
    }) {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.turn.queue.cancel",
        commandId: yield* serverCommandId("queued-turn-wedge-cancel"),
        threadId: input.threadId,
        messageId: input.messageId,
        reason: input.reason,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("queued-turn-wedge-note"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "error",
          kind: "queued-delivery.wedged",
          summary: "A queued message was cancelled after delivery stalled.",
          payload: {
            messageId: input.messageId,
            redeliveryCount: input.redeliveryCount,
            reason: input.reason,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      // The error activity above lands on the (probably wedged) child's own
      // thread, where nobody who can act on it is looking. The parent is the
      // one holding the spawn slot, so it gets told directly — this is the
      // "delivered but never consumed" signature surfacing instead of rotting.
      if (wedgedThreadsNotified.has(input.threadId)) return;
      const child = yield* snapshotQuery.getThreadShellById(input.threadId);
      const childTitle = Option.isSome(child) ? child.value.title : input.threadId;
      yield* notifyParent({
        origin: { kind: "phoenix", threadId: input.threadId },
        childThreadId: input.threadId,
        text: `[Phoenix] Spawned session "${childTitle}" appears WEDGED: a queued message entered delivery but never started a turn, and has now been cancelled (messageId ${input.messageId}, retries ${input.redeliveryCount}). Further send_to_session calls may stall the same way. Consider stop_session followed by a fresh send_to_session to restart it, or spawn a replacement.\n\n(spawned thread: ${input.threadId})`,
        commandTag: "queued-turn-wedge-notify",
      });
      wedgedThreadsNotified.add(input.threadId);
    },
  );

  const cancelTerminalQueue = Effect.fn("SessionSpawnReactor.cancelTerminalQueue")(function* (
    threadId: ThreadId,
    _status: "stopped" | "error",
  ) {
    yield* cancelQueuedTurns({ threadId, reason: "session_terminal" });
  });

  /**
   * What a dead child's worktree holds, for its death notice.
   *
   * Best-effort and bounded: the full status includes a change-request
   * lookup that can hang on a slow host, and a death notice that arrives
   * minutes late has failed at its one job. On timeout or error the counts
   * degrade to null ("could not be inspected") rather than reading clean.
   */
  const resolveTerminalWorktreeRisk = Effect.fn("SessionSpawnReactor.resolveTerminalWorktreeRisk")(
    function* (shell: OrchestrationThreadShell) {
      const worktreePath = shell.worktreePath;
      if (worktreePath === null) return null;
      const status = yield* gitWorkflow.status({ cwd: worktreePath }).pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (status === null || !status.isRepo) {
        return {
          worktreePath,
          branch: shell.branch,
          dirtyFileCount: null,
          unpushedCommitCount: null,
        } satisfies TerminalWorktreeRisk;
      }
      return {
        worktreePath,
        branch: status.refName ?? shell.branch,
        dirtyFileCount: status.workingTree.files.length,
        // Same accounting as settle_session's cleanup risk: with an
        // upstream, unpushed is what the remote lacks; without one, every
        // commit past the default branch exists only here.
        unpushedCommitCount: status.hasUpstream
          ? status.aheadCount
          : (status.aheadOfDefaultCount ?? 0),
      } satisfies TerminalWorktreeRisk;
    },
  );

  const notifyParent = Effect.fn("SessionSpawnReactor.notifyParent")(function* (input: {
    readonly childThreadId: ThreadId;
    readonly text: string;
    readonly commandTag: string;
    readonly commandId?: CommandId | undefined;
    readonly messageId?: MessageId | undefined;
    /** Who is speaking: the child session itself, or Phoenix about it. */
    readonly origin: OrchestrationMessageOrigin;
  }) {
    const child = yield* snapshotQuery.getThreadShellById(input.childThreadId);
    if (Option.isNone(child)) return;
    const parentThreadId = child.value.spawnedByThreadId ?? null;
    if (parentThreadId === null) return;
    const parent = yield* snapshotQuery.getThreadShellById(ThreadId.make(parentThreadId));
    if (Option.isNone(parent)) {
      yield* Effect.logDebug("spawned-session notification dropped: parent thread not active", {
        childThreadId: input.childThreadId,
        parentThreadId,
      });
      return;
    }
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: input.commandId ?? (yield* serverCommandId(input.commandTag)),
      threadId: parent.value.id,
      message: {
        messageId: input.messageId ?? MessageId.make(yield* randomUUID),
        role: "user",
        text: input.text,
        attachments: [],
        origin: input.origin,
      },
      runtimeMode: parent.value.runtimeMode,
      interactionMode: parent.value.interactionMode,
      createdAt,
    });
  });

  /**
   * Post a report on behalf of a spawned child that terminated silently.
   *
   * The report goes through the ordinary `thread.report.post` command, so the
   * projection, the user-facing report card, and the parent notification
   * (driven by the resulting `thread.report-posted`) all behave exactly as
   * they do for an agent-posted report.
   */
  const synthesizeTerminalReport = Effect.fn("SessionSpawnReactor.synthesizeTerminalReport")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly sessionStatus: OrchestrationSessionStatus;
      readonly exitReason: SessionExitReason;
      readonly lastError: string | null;
      readonly session: OrchestrationSession;
    }) {
      const detail = yield* snapshotQuery.getThreadDetailById(input.threadId);
      // Only spawned children get synthesized reports: a report on a thread
      // nobody is waiting on is noise in the user's timeline.
      if (Option.isNone(detail) || (detail.value.spawnedByThreadId ?? null) === null) {
        return { isSpawnedChild: false, hadAgentReport: false, reportId: null } as const;
      }
      const episodeStartedAt = input.session.episodeStartedAt ?? null;
      const episodeReports =
        episodeStartedAt === null
          ? detail.value.reports
          : detail.value.reports.filter((report) => report.createdAt >= episodeStartedAt);
      // Historical reports belong to earlier provider episodes. Only an agent
      // report written after this episode began can stand in for its account.
      if (episodeReports.some((report) => report.origin !== "system")) {
        return { isSpawnedChild: true, hadAgentReport: true, reportId: null } as const;
      }

      // A prior partial attempt may have persisted the synthesized report but
      // failed before notifying the parent. Reuse it so the notice retains the
      // report-delivery correlation instead of manufacturing another account.
      const existingSystemReport = episodeReports.find((report) => report.origin === "system");
      if (existingSystemReport !== undefined) {
        return {
          isSpawnedChild: true,
          hadAgentReport: false,
          reportId: existingSystemReport.reportId,
        } as const;
      }

      const createdAt = yield* nowIso;
      // What the child cost before it died, so the parent is not left
      // guessing along with the "unverified" warning below.
      const usage = yield* resolveSessionUsageSnapshot(snapshotQuery, {
        threadId: input.threadId,
        createdAt: detail.value.createdAt,
        latestTurn: detail.value.latestTurn,
      });
      const episodeKey = episodeStartedAt ?? input.session.updatedAt;
      const reportId = `session-terminal-report:${input.threadId}:${episodeKey}`;
      yield* engine
        .dispatch({
          type: "thread.report.post",
          commandId: CommandId.make(`session-terminal-report:${input.threadId}:${episodeKey}`),
          threadId: input.threadId,
          reportId,
          status: terminalReportStatus(input.sessionStatus),
          title: terminalReportTitle(input.sessionStatus),
          summary: buildTerminalReportSummary({
            sessionStatus: input.sessionStatus,
            exitReason: input.exitReason,
            lastError: input.lastError,
            session: input.session,
            detail,
          }),
          artifacts: [],
          usage,
          // Structured fields carry the same warning in machine-readable form,
          // so a parent that reads `validation.gaps` rather than the markdown
          // still learns nothing here was checked. completionPercent is left
          // unset on purpose: the truthful answer is "unknown", and 0 would
          // assert more than Phoenix knows.
          validation: {
            performed: [],
            gaps: [
              "The session terminated before posting a report; none of its work was verified by its agent.",
            ],
          },
          recommendation:
            "Inspect the thread with read_session before relying on any of this work, then re-spawn or re-assign it if it still needs doing.",
          origin: "system",
          createdAt,
        })
        // A terminated session emits no further status transition, so this is
        // the last chance to reach the parent: a transient dispatch failure
        // here would otherwise mean permanent silence.
        .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential(100) }));
      return { isSpawnedChild: true, hadAgentReport: false, reportId } as const;
    },
  );

  const processDeathNotice = Effect.fn("SessionSpawnReactor.processDeathNotice")(function* (
    input: DeathNoticeInput,
  ) {
    yield* notifyParent({
      origin: { kind: "phoenix", threadId: input.threadId },
      childThreadId: input.threadId,
      text: formatDeathNotice({
        childTitle: input.shell.title,
        childThreadId: input.threadId,
        exitReason: input.exitReason,
        lastError: input.lastError,
        worktree: yield* resolveTerminalWorktreeRisk(input.shell),
        synthesizedReportId: input.synthesizedReportId,
        hadAgentReport: input.hadAgentReport,
      }),
      commandTag: "session-death-notice",
      commandId: CommandId.make(`session-death-notice:${input.threadId}:${input.episodeKey}`),
      messageId:
        input.synthesizedReportId !== null
          ? MessageId.make(
              `${SESSION_REPORT_DELIVERY_MESSAGE_PREFIX}${input.threadId}:${input.synthesizedReportId}`,
            )
          : MessageId.make(`session-death-notice:${input.threadId}:${input.episodeKey}`),
    }).pipe(Effect.retry({ times: 2, schedule: Schedule.exponential(100) }));
    terminalReportedThreads.set(input.threadId, input.episodeKey);
  });

  let deathNoticeWorker!: DrainableWorker<DeathNoticeInput>;

  const processTerminalSession = Effect.fn("SessionSpawnReactor.processTerminalSession")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession & { readonly status: "stopped" | "error" };
    }) {
      const { threadId, session } = input;
      // Three reactions to the same terminal episode, in this order on
      // purpose. Cancelling the queue first tells the parent its pending
      // work was dropped; the synthesized report (when the child never
      // reported) preserves the durable account; the death notice then
      // wakes the parent with the exit reason, the worktree's git state,
      // and where that account lives. Deterministic command ids make this
      // safe both for event replay and startup recovery after a crash.
      yield* cancelTerminalQueue(threadId, session.status);
      const episodeKey = session.episodeStartedAt ?? session.updatedAt;
      if (terminalReportedThreads.get(threadId) === episodeKey) return;
      const exitReason = deriveSessionExitReason(session);
      const outcome = yield* synthesizeTerminalReport({
        threadId,
        sessionStatus: session.status,
        exitReason,
        lastError: session.lastError ?? null,
        session,
      });
      if (!outcome.isSpawnedChild) return;
      const shell = yield* snapshotQuery.getThreadShellById(threadId);
      // A parent-initiated stop (stop_session, settle, archive) is the one
      // death the parent cannot be surprised by — it caused it. Waking it
      // with a notice would turn every settle into a self-notification. The
      // synthesized report above still preserves the durable record.
      if (Option.isSome(shell) && exitReason !== "stopped_by_parent") {
        // Unlike report delivery, the death notice ignores reportDelivery:
        // "notify-only" opts out of report chatter, not out of learning the
        // child died. It is the one message that must always land — see
        // formatDeathNotice.
        yield* deathNoticeWorker.enqueue({
          threadId,
          shell: shell.value,
          exitReason,
          lastError: session.lastError ?? null,
          synthesizedReportId: outcome.reportId,
          hadAgentReport: outcome.hadAgentReport,
          episodeKey,
        });
      } else {
        terminalReportedThreads.set(threadId, episodeKey);
      }
    },
  );

  const processEvent = Effect.fn("SessionSpawnReactor.processEvent")(function* (
    event: WatchedEvent,
  ) {
    if (event.type === "thread.turn-start-queued") return;
    if (event.type === "thread.turn-start-requested") {
      // A parent turn starting on a delivered report message IS the parent
      // reading that report — with queue delivery (the default) the agent
      // gets the full text as its input and has no reason to ever call
      // read_report, which used to leave the inbox entry unread forever.
      // The receipt is byte-identical to read_report's (same deterministic
      // command and activity ids), so the two acknowledgement paths converge
      // on one durable record instead of double-counting.
      const delivery = parseReportDeliveryMessageId(event.payload.messageId);
      if (delivery === null) return;
      const child = yield* snapshotQuery.getThreadDetailById(ThreadId.make(delivery.childThreadId));
      const report = Option.isSome(child)
        ? child.value.reports.find((candidate) => candidate.reportId === delivery.reportId)
        : undefined;
      if (
        Option.isNone(child) ||
        child.value.spawnedByThreadId !== event.payload.threadId ||
        !report
      ) {
        yield* Effect.logWarning("ignored invalid session report delivery receipt", {
          parentThreadId: event.payload.threadId,
          childThreadId: delivery.childThreadId,
          reportId: delivery.reportId,
        });
        return;
      }
      // `origin` is server-only on a turn start; the client command schema
      // strips it. Agent reports arrive as the child session speaking, while
      // Phoenix-authored terminal reports arrive through a Phoenix death
      // notice. Match the persisted report's author so both legitimate paths
      // are accepted without trusting a client-chosen message-id prefix.
      const expectedOriginKind = report.origin === "system" ? "phoenix" : "session";
      if (
        event.payload.origin?.kind !== expectedOriginKind ||
        event.payload.origin.threadId !== delivery.childThreadId
      ) {
        yield* Effect.logWarning("ignored untrusted session report delivery receipt", {
          parentThreadId: event.payload.threadId,
          childThreadId: delivery.childThreadId,
          reportId: delivery.reportId,
        });
        return;
      }
      const readAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `session-report-read:${event.payload.threadId}:${delivery.reportId}`,
        ),
        threadId: event.payload.threadId,
        activity: {
          id: EventId.make(`session-report-read:${event.payload.threadId}:${delivery.reportId}`),
          tone: "info",
          kind: "session-report.read",
          summary: "Parent received child report",
          payload: {
            childThreadId: delivery.childThreadId,
            reportId: delivery.reportId,
            readByThreadId: event.payload.threadId,
            readAt,
          },
          turnId: null,
          createdAt: readAt,
        },
        createdAt: readAt,
      });
      return;
    }
    if (event.type === "thread.report-posted") {
      const child = yield* snapshotQuery.getThreadShellById(event.payload.threadId);
      if (Option.isNone(child)) {
        yield* Effect.logDebug(
          "spawned-session report notification dropped: child thread not active",
          {
            childThreadId: event.payload.threadId,
            reportId: event.payload.report.reportId,
          },
        );
        return;
      }
      const parentThreadId = child.value.spawnedByThreadId ?? null;
      if (parentThreadId === null) {
        yield* Effect.logDebug("spawned-session report notification dropped: child has no parent", {
          childThreadId: event.payload.threadId,
          reportId: event.payload.report.reportId,
        });
        return;
      }
      const parent = yield* snapshotQuery.getThreadShellById(ThreadId.make(parentThreadId));
      if (Option.isNone(parent)) {
        yield* Effect.logDebug(
          "spawned-session report notification dropped: parent thread not active",
          {
            childThreadId: event.payload.threadId,
            parentThreadId,
            reportId: event.payload.report.reportId,
          },
        );
        return;
      }
      const notifiedAt = yield* nowIso;
      const activity = reportNotificationActivity({
        parentThreadId: parent.value.id,
        childThreadId: event.payload.threadId,
        childTitle: child.value.title,
        report: event.payload.report,
        notifiedAt,
      });
      // Command ID and activity ID are both deterministic. A stream replay
      // after a crash reuses the receipt; a partial projection retry replaces
      // the same activity rather than making a second notification.
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `session-report-notification:${parent.value.id}:${event.payload.threadId}:${event.payload.report.reportId}`,
        ),
        threadId: parent.value.id,
        activity,
        createdAt: notifiedAt,
      });
      // The activity above is the durable inbox row and is written either way.
      // Delivery decides only whether the parent's model hears about it now:
      // "queue" hands the report over the same path a human message takes, so
      // an idle parent wakes on it and a busy one receives it after its
      // current turn. "notify-only" leaves the parent to read on its own
      // schedule. A child spawned before this was configurable has no stored
      // preference, so it takes the default. A system-origin report is never
      // delivered as a message at all: it only exists because the session
      // terminated, and the death notice (which always goes out, and names
      // this report) is the single wake for that event — two messages for
      // one death would double-turn every parent.
      if (event.payload.report.origin === "system") return;
      const delivery = child.value.reportDelivery ?? DEFAULT_SESSION_REPORT_DELIVERY;
      if (delivery === "notify-only") return;
      // A report written over unconsumed queued messages is answering a
      // conversation the child never heard: say so in the same delivery,
      // instead of letting the parent believe its last instructions were
      // taken into account.
      const unconsumed = (yield* projectionTurnRepository.listQueuedTurnStarts.pipe(
        Effect.catch(() => Effect.succeed([])),
      )).filter((entry) => entry.threadId === event.payload.threadId);
      yield* notifyParent({
        // A delivered report is the child speaking (its own account of the
        // work), even though Phoenix formatted the envelope.
        origin: { kind: "session", threadId: event.payload.threadId },
        childThreadId: event.payload.threadId,
        text: `${formatReportMessage(child.value.title, event.payload.report)}${formatQueuedReportWarning(unconsumed.map((entry) => entry.messageId))}`,
        commandTag: "session-report-delivery",
        // Deterministic for the same reason the activity is: a replay after a
        // crash re-dispatches an already-receipted command instead of
        // delivering the same report to the parent a second time.
        commandId: CommandId.make(
          `session-report-delivery:${parent.value.id}:${event.payload.threadId}:${event.payload.report.reportId}`,
        ),
        messageId: MessageId.make(
          `session-report-delivery:${event.payload.threadId}:${event.payload.report.reportId}`,
        ),
      });
      return;
    }

    const { threadId, session } = event.payload;
    if (
      session.status === "idle" ||
      session.status === "ready" ||
      session.status === "interrupted"
    ) {
      wedgedThreadsNotified.delete(threadId);
      yield* releaseNextQueuedTurn(threadId);
    }
    if (isTerminalStatus(session.status)) {
      yield* processTerminalSession({ threadId, session });
      return;
    }
    if (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "ready"
    ) {
      wedgedThreadsNotified.delete(threadId);
      terminalReportedThreads.delete(threadId);
    }
  });

  let worker!: DrainableWorker<WorkerInput>;
  const scheduledInterruptTimeouts = new Set<string>();

  const scheduleInterruptTimeout = Effect.fn("SessionSpawnReactor.scheduleInterruptTimeout")(
    function* (queued: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly mode: "queue" | "interrupt";
      readonly requestedAt: string;
    }) {
      if (queued.mode !== "interrupt") return;
      const key = `${queued.threadId}:${queued.messageId}`;
      const requestedAtMs = Date.parse(queued.requestedAt);
      if (!Number.isFinite(requestedAtMs)) {
        scheduledInterruptTimeouts.delete(key);
        yield* Effect.logWarning("session spawn reactor ignored invalid interrupt deadline", {
          threadId: queued.threadId,
          messageId: queued.messageId,
          requestedAt: queued.requestedAt,
        });
        return;
      }
      const elapsed = Math.max(0, (yield* Clock.currentTimeMillis) - requestedAtMs);
      const remaining = Math.max(0, Duration.toMillis(INTERRUPT_FALLBACK_TIMEOUT) - elapsed);
      yield* Effect.sleep(Duration.millis(remaining)).pipe(
        Effect.andThen(
          worker.enqueue({
            type: "interrupt-timeout",
            threadId: queued.threadId,
            messageId: queued.messageId,
          }),
        ),
        Effect.ensuring(Effect.sync(() => scheduledInterruptTimeouts.delete(key))),
      );
    },
  );

  const forkInterruptTimeout = Effect.fn("SessionSpawnReactor.forkInterruptTimeout")(function* (
    queued: Parameters<typeof scheduleInterruptTimeout>[0],
  ) {
    if (queued.mode !== "interrupt") return;
    const key = `${queued.threadId}:${queued.messageId}`;
    if (scheduledInterruptTimeouts.has(key)) return;
    scheduledInterruptTimeouts.add(key);
    yield* scheduleInterruptTimeout(queued).pipe(Effect.forkScoped);
  });

  const processInput = Effect.fn("SessionSpawnReactor.processInput")(function* (
    input: WorkerInput,
  ) {
    if (input.type === "event") {
      yield* processEvent(input.event);
      if (input.event.type === "thread.turn-start-queued") {
        yield* forkInterruptTimeout({
          threadId: input.event.payload.threadId,
          messageId: input.event.payload.messageId,
          mode: input.event.payload.mode,
          requestedAt: input.event.payload.createdAt,
        });
      }
      return;
    }
    if (input.type === "recover") {
      const queuedForThread = (yield* projectionTurnRepository.listQueuedTurnStarts).filter(
        (entry) => entry.threadId === input.threadId,
      );
      yield* Effect.forEach(queuedForThread, forkInterruptTimeout);
      const staleBefore = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, {
          milliseconds: -Duration.toMillis(RELEASING_RECOVERY_AGE),
        }),
      );
      const liveStaleBefore = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, {
          milliseconds: -Duration.toMillis(LIVE_RELEASING_MAX_AGE),
        }),
      );
      const shell = yield* snapshotQuery.getThreadShellById(input.threadId);
      if (Option.isNone(shell)) return;
      const session = shell.value.session;
      if (session !== null && isTerminalStatus(session.status)) {
        yield* processTerminalSession({ threadId: input.threadId, session });
        return;
      }
      const live = (yield* providerService.listSessions()).some(
        (entry) => entry.threadId === input.threadId,
      );
      // Recovery assumes directory absence means no provider binding, not a transient rebind gap.
      const sessionUpdatedAtMs = session === null ? Number.NaN : Date.parse(session.updatedAt);
      const stale =
        session !== null &&
        Number.isFinite(sessionUpdatedAtMs) &&
        (yield* Clock.currentTimeMillis) - sessionUpdatedAtMs >=
          Duration.toMillis(RECOVERY_INTERVAL);
      const canRecoverReleasing =
        session === null ||
        session.status === "idle" ||
        session.status === "ready" ||
        session.status === "interrupted" ||
        ((session.status === "starting" || session.status === "running") && !live && stale);
      if (live && (session?.status === "starting" || session?.status === "running")) {
        yield* Effect.forEach(
          queuedForThread.filter(
            (entry) =>
              entry.state === "releasing" &&
              entry.releasingAt !== null &&
              entry.releasingAt <= liveStaleBefore,
          ),
          (entry) =>
            cancelWedgedDelivery({
              threadId: input.threadId,
              messageId: entry.messageId,
              reason: "delivery_stalled",
              redeliveryCount: entry.redeliveryCount,
            }),
          { concurrency: 1 },
        );
      }
      if (canRecoverReleasing) {
        yield* Effect.forEach(
          queuedForThread.filter(
            (entry) =>
              entry.state === "releasing" &&
              entry.releasingAt !== null &&
              entry.releasingAt <= staleBefore,
          ),
          (entry) =>
            Effect.gen(function* () {
              if (entry.redeliveryCount >= MAX_QUEUED_TURN_REDELIVERIES) {
                yield* cancelWedgedDelivery({
                  threadId: input.threadId,
                  messageId: entry.messageId,
                  reason: "redelivery_limit_reached",
                  redeliveryCount: entry.redeliveryCount,
                });
                return;
              }
              const createdAt = yield* nowIso;
              yield* engine.dispatch({
                type: "thread.turn.queue.requeue",
                commandId: yield* serverCommandId("queued-turn-requeue"),
                threadId: input.threadId,
                messageId: entry.messageId,
                createdAt,
              });
            }),
          { concurrency: 1 },
        );
      }
      if ((session?.status === "starting" || session?.status === "running") && !live && stale) {
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: yield* serverCommandId("queued-turn-recover-session"),
          threadId: input.threadId,
          session: {
            ...session,
            status: "interrupted",
            activeTurnId: null,
            updatedAt: yield* nowIso,
          },
          createdAt: yield* nowIso,
        });
        yield* releaseNextQueuedTurn(input.threadId);
        return;
      }
      if (
        session === null ||
        session.status === "idle" ||
        session.status === "ready" ||
        session.status === "interrupted"
      ) {
        yield* releaseNextQueuedTurn(input.threadId);
      }
      return;
    }
    const queued = (yield* projectionTurnRepository.listQueuedTurnStarts).find(
      (entry) =>
        entry.threadId === input.threadId &&
        entry.messageId === input.messageId &&
        entry.state === "queued",
    );
    if (queued === undefined) return;
    const shell = yield* snapshotQuery.getThreadShellById(input.threadId);
    if (Option.isNone(shell)) return;
    if (shell.value.session?.status !== "starting" && shell.value.session?.status !== "running") {
      yield* releaseNextQueuedTurn(input.threadId);
      return;
    }
    yield* engine.dispatch({
      type: "thread.turn.queue.cancel",
      commandId: yield* serverCommandId("queued-turn-interrupt-timeout-cancel"),
      threadId: input.threadId,
      messageId: input.messageId,
      reason: "interrupt_timeout",
      createdAt: yield* nowIso,
    });
    yield* engine.dispatch({
      type: "thread.session.stop",
      commandId: yield* serverCommandId("queued-turn-interrupt-timeout-stop"),
      threadId: input.threadId,
      createdAt: yield* nowIso,
    });
    yield* notifyParent({
      origin: { kind: "phoenix", threadId: input.threadId },
      childThreadId: input.threadId,
      text: `[Phoenix] Interrupt delivery timed out; the queued replacement was cancelled and the spawned session was stopped.\n\n(spawned thread: ${input.threadId})`,
      commandTag: "queued-turn-interrupt-timeout-notify",
    });
  });

  const processInputSafely = (input: WorkerInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("session spawn reactor failed to process event", {
          inputType: input.type,
          threadId: input.type === "event" ? input.event.payload.threadId : input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  deathNoticeWorker = yield* makeDrainableWorker<DeathNoticeInput, never, never>((input) =>
    processDeathNotice(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("session death notice failed", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  worker = yield* makeDrainableWorker(processInputSafely);

  const start: SessionSpawnReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.report-posted" &&
          event.type !== "thread.session-set" &&
          event.type !== "thread.turn-start-queued" &&
          event.type !== "thread.turn-start-requested"
        ) {
          return Effect.void;
        }
        // Turn starts are frequent; only report-delivery consumptions are
        // worth a trip through the worker.
        if (
          event.type === "thread.turn-start-requested" &&
          parseReportDeliveryMessageId(event.payload.messageId) === null
        ) {
          return Effect.void;
        }
        return worker.enqueue({ type: "event", event });
      }),
    );
    const enqueueRecovery = Effect.fn("SessionSpawnReactor.enqueueRecovery")(
      function* () {
        const queuedThreadIds = new Set(
          (yield* projectionTurnRepository.listQueuedTurnStarts).map((entry) => entry.threadId),
        );
        yield* Effect.forEach(
          queuedThreadIds,
          (threadId) => worker.enqueue({ type: "recover", threadId }),
          { concurrency: 1 },
        );
      },
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("session spawn reactor failed to enqueue queued-turn recovery", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* enqueueRecovery();
    // Queue rows are not the only durable evidence that work remains. A
    // process can stop after persisting a terminal session/report but before
    // its asynchronous death notice lands. Revisit every spawned terminal
    // shell once at startup; deterministic report and notice command ids make
    // already-completed episodes no-ops while repairing that crash window.
    const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
    yield* Effect.forEach(
      shellSnapshot.threads,
      (thread) => {
        const session = thread.session;
        return thread.spawnedByThreadId !== null &&
          session !== null &&
          isTerminalStatus(session.status)
          ? processInputSafely({ type: "recover", threadId: thread.id })
          : Effect.void;
      },
      { concurrency: 1 },
    );
    yield* forkParked(
      Effect.sleep(RECOVERY_INTERVAL).pipe(Effect.andThen(enqueueRecovery()), Effect.forever),
    );
  });

  return {
    start,
    // Drain the event worker first: it is the producer for the notice worker.
    // Running both drains concurrently could observe an empty notice queue
    // just before the final terminal event enqueues its notice.
    drain: worker.drain.pipe(Effect.andThen(deathNoticeWorker.drain)),
  } satisfies SessionSpawnReactorShape;
});

export const SessionSpawnReactorLive = Layer.effect(
  SessionSpawnReactor,
  makeSessionSpawnReactor,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
