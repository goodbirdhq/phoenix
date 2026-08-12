import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type SessionReport,
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
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  SessionSpawnReactor,
  type SessionSpawnReactorShape,
} from "../Services/SessionSpawnReactor.ts";

type ReportPostedEvent = Extract<OrchestrationEvent, { type: "thread.report-posted" }>;
type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type TurnQueuedEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-queued" }>;
type WatchedEvent = ReportPostedEvent | SessionSetEvent | TurnQueuedEvent;
type WorkerInput =
  | { readonly type: "event"; readonly event: WatchedEvent }
  | { readonly type: "recover"; readonly threadId: ThreadId }
  | {
      readonly type: "interrupt-timeout";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
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

const truncate = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

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
  // A synthesized report must never read as if the child wrote it: the parent
  // decides what to do next based on who is claiming the work is over.
  const lead =
    report.origin === "system"
      ? `[Phoenix] Spawned session "${childTitle}" ended without posting a report. Phoenix generated a ${report.status} report for it: ${report.title}`
      : `[Phoenix] Spawned session "${childTitle}" posted a ${report.status} report: ${report.title}`;
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

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  // A session can bounce through terminal states repeatedly (retries,
  // restarts). Synthesize at most one terminal report per episode; a later
  // healthy state re-arms.
  const terminalReportedThreads = new Set<string>();

  const releaseNextQueuedTurn = Effect.fn("SessionSpawnReactor.releaseNextQueuedTurn")(function* (
    threadId: ThreadId,
  ) {
    const queued = (yield* projectionTurnRepository.listQueuedTurnStarts).find(
      (entry) => entry.threadId === threadId,
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
    readonly reason: "session_terminal" | "interrupt_timeout";
  }) {
    const queued = (yield* projectionTurnRepository.listQueuedTurnStarts).filter(
      (entry) => entry.threadId === input.threadId,
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

  const cancelTerminalQueue = Effect.fn("SessionSpawnReactor.cancelTerminalQueue")(function* (
    threadId: ThreadId,
    status: "stopped" | "error",
  ) {
    const cancelled = yield* cancelQueuedTurns({ threadId, reason: "session_terminal" });
    if (cancelled === 0) return;
    yield* notifyParent({
      childThreadId: threadId,
      text: `[Phoenix] ${cancelled} queued message${cancelled === 1 ? " was" : "s were"} cancelled because the spawned session entered ${status} state.\n\n(spawned thread: ${threadId})`,
      commandTag: "queued-turn-cancel-notify",
    });
  });

  const notifyParent = Effect.fn("SessionSpawnReactor.notifyParent")(function* (input: {
    readonly childThreadId: ThreadId;
    readonly text: string;
    readonly commandTag: string;
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
      commandId: yield* serverCommandId(input.commandTag),
      threadId: parent.value.id,
      message: {
        messageId: MessageId.make(yield* randomUUID),
        role: "user",
        text: input.text,
        attachments: [],
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
      readonly lastError: string | null;
      readonly session: OrchestrationSession;
    }) {
      const detail = yield* snapshotQuery.getThreadDetailById(input.threadId);
      // Only spawned children get synthesized reports: a report on a thread
      // nobody is waiting on is noise in the user's timeline.
      if (Option.isNone(detail) || (detail.value.spawnedByThreadId ?? null) === null) return false;
      // The agent already had its say; a synthesized report would only muddy
      // which one the parent should believe. This persisted check — not the
      // in-memory episode set — is the real guard against duplicates.
      if (detail.value.reports.length > 0) return true;

      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.report.post",
          commandId: yield* serverCommandId("spawn-terminal-report"),
          threadId: input.threadId,
          reportId: yield* randomUUID,
          status: terminalReportStatus(input.sessionStatus),
          title: terminalReportTitle(input.sessionStatus),
          summary: buildTerminalReportSummary({
            sessionStatus: input.sessionStatus,
            lastError: input.lastError,
            session: input.session,
            detail,
          }),
          artifacts: [],
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
      return true;
    },
  );

  const processEvent = Effect.fn("SessionSpawnReactor.processEvent")(function* (
    event: WatchedEvent,
  ) {
    if (event.type === "thread.turn-start-queued") return;
    if (event.type === "thread.report-posted") {
      const child = yield* snapshotQuery.getThreadShellById(event.payload.threadId);
      const childTitle = Option.isSome(child) ? child.value.title : event.payload.threadId;
      yield* notifyParent({
        childThreadId: event.payload.threadId,
        text: formatReportMessage(childTitle, event.payload.report),
        commandTag: "spawn-report-notify",
      });
      return;
    }

    const { threadId, session } = event.payload;
    if (
      session.status === "idle" ||
      session.status === "ready" ||
      session.status === "interrupted"
    ) {
      yield* releaseNextQueuedTurn(threadId);
    }
    if (isTerminalStatus(session.status)) {
      // Two independent reactions to the same terminal event, in this order on
      // purpose. Cancelling the queue first tells the parent its pending work
      // was dropped; the synthesized report then explains where the child
      // actually stopped. Reversing them would deliver the epitaph before the
      // news that queued messages died with it. Neither depends on the other:
      // cancellation is a no-op with an empty queue, and a second terminal
      // event re-runs it harmlessly (nothing left to cancel, so no notice).
      yield* cancelTerminalQueue(threadId, session.status);
      if (terminalReportedThreads.has(threadId)) return;
      const reported = yield* synthesizeTerminalReport({
        threadId,
        sessionStatus: session.status,
        lastError: session.lastError ?? null,
        session,
      });
      // Marked only once the report is actually persisted. Marking up front
      // would let a failed dispatch — which processInputSafely swallows —
      // brand the episode "handled" with nothing stored, and a stopped
      // session has no later transition to re-arm the guard.
      if (reported) {
        terminalReportedThreads.add(threadId);
      }
      return;
    }
    if (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "ready"
    ) {
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
      const shell = yield* snapshotQuery.getThreadShellById(input.threadId);
      if (Option.isNone(shell)) return;
      const session = shell.value.session;
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
      if (session?.status === "stopped" || session?.status === "error") {
        yield* cancelTerminalQueue(input.threadId, session.status);
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
      (entry) => entry.threadId === input.threadId && entry.messageId === input.messageId,
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

  worker = yield* makeDrainableWorker(processInputSafely);

  const start: SessionSpawnReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.report-posted" &&
          event.type !== "thread.session-set" &&
          event.type !== "thread.turn-start-queued"
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
    yield* forkParked(
      Effect.sleep(RECOVERY_INTERVAL).pipe(Effect.andThen(enqueueRecovery()), Effect.forever),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies SessionSpawnReactorShape;
});

export const SessionSpawnReactorLive = Layer.effect(
  SessionSpawnReactor,
  makeSessionSpawnReactor,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
