import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type SessionReport,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const INTERRUPT_FALLBACK_TIMEOUT = Duration.seconds(30);
const RECOVERY_INTERVAL = Duration.seconds(30);

const formatReportMessage = (childTitle: string, report: SessionReport): string => {
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
  return `[Phoenix] Spawned session "${childTitle}" posted a ${report.status} report: ${report.title}\n\n${report.summary}${artifactLines}\n\n(spawned thread: ${report.threadId})`;
};

const formatErrorMessage = (childTitle: string, threadId: string, lastError: string | null) =>
  `[Phoenix] Spawned session "${childTitle}" hit a provider error${
    lastError ? `: ${lastError}` : "."
  } It has not posted a report. Use read_session to inspect it, send_to_session to retry, or stop_session to give up.\n\n(spawned thread: ${threadId})`;

export const makeSessionSpawnReactor = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerService = yield* ProviderService;

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  // A session can bounce through error states repeatedly (retries, restarts).
  // Notify the parent once per error episode; a later healthy state re-arms.
  const errorNotifiedThreads = new Set<string>();

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
    if (session.status === "stopped" || session.status === "error") {
      yield* cancelTerminalQueue(threadId, session.status);
    }
    if (session.status === "error") {
      if (errorNotifiedThreads.has(threadId)) return;
      errorNotifiedThreads.add(threadId);
      const child = yield* snapshotQuery.getThreadShellById(threadId);
      const childTitle = Option.isSome(child) ? child.value.title : threadId;
      yield* notifyParent({
        childThreadId: threadId,
        text: formatErrorMessage(childTitle, threadId, session.lastError ?? null),
        commandTag: "spawn-error-notify",
      });
      return;
    }
    if (session.status === "running" || session.status === "ready") {
      errorNotifiedThreads.delete(threadId);
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
