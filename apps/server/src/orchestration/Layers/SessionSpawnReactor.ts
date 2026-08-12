import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type SessionReport,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  SessionSpawnReactor,
  type SessionSpawnReactorShape,
} from "../Services/SessionSpawnReactor.ts";

type ReportPostedEvent = Extract<OrchestrationEvent, { type: "thread.report-posted" }>;
type SessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type WatchedEvent = ReportPostedEvent | SessionSetEvent;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

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
    if (session.status !== "starting" && session.status !== "running") {
      yield* releaseNextQueuedTurn(threadId);
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

  const processEventSafely = (event: WatchedEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("session spawn reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: SessionSpawnReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (event.type !== "thread.report-posted" && event.type !== "thread.session-set") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* Effect.gen(function* () {
      const queuedThreadIds = new Set(
        (yield* projectionTurnRepository.listQueuedTurnStarts).map((entry) => entry.threadId),
      );
      yield* Effect.forEach(
        queuedThreadIds,
        (threadId) =>
          snapshotQuery.getThreadShellById(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (thread) =>
                  thread.session?.status === "starting" || thread.session?.status === "running"
                    ? Effect.void
                    : releaseNextQueuedTurn(threadId),
              }),
            ),
          ),
        { concurrency: 1 },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("session spawn reactor failed to recover queued turns", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies SessionSpawnReactorShape;
});

export const SessionSpawnReactorLive = Layer.effect(SessionSpawnReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
