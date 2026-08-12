/**
 * SessionSpawnReactor event-processing tests.
 *
 * The reactor's per-episode dedup set is the kind of state that pure-helper
 * tests cannot see: marking an episode "reported" before the dispatch actually
 * lands silently strands the parent, because a stopped session emits no further
 * transition to re-arm the guard. These drive the real reactor against a stub
 * engine to pin that ordering down.
 */
import {
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import { makeSessionSpawnReactor } from "./SessionSpawnReactor.ts";

const PARENT_THREAD_ID = ThreadId.make("parent-thread");
const CHILD_THREAD_ID = ThreadId.make("child-thread");
const PROJECT_ID = ProjectId.make("project-1");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const sessionSetEvent = (status: "stopped" | "error", index: number): OrchestrationEvent =>
  ({
    eventId: EventId.make(`event-${index}`),
    sequence: index,
    aggregateKind: "thread",
    aggregateId: CHILD_THREAD_ID,
    occurredAt: CREATED_AT,
    type: "thread.session-set",
    payload: {
      threadId: CHILD_THREAD_ID,
      session: {
        threadId: CHILD_THREAD_ID,
        status,
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: null,
        lastError: status === "error" ? "provider exited" : null,
        updatedAt: CREATED_AT,
      },
    },
  }) as unknown as OrchestrationEvent;

interface HarnessOptions {
  // Every dispatch of the synthesized report fails, as a transient infra
  // failure or a decider rejection would.
  readonly reportDispatchFails?: boolean;
  // The child already has an agent-posted report.
  readonly existingReports?: number;
  readonly spawnedByThreadId?: ThreadId | null;
}

const runReactor = (events: ReadonlyArray<OrchestrationEvent>, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const reportDispatches: Array<string> = [];
    const parentTurns: Array<string> = [];
    // Deterministic hand-off instead of sleeping: resolves once the stream has
    // handed every event to the reactor's worker.
    const allEventsEnqueued = yield* Deferred.make<void>();

    const engine = {
      streamDomainEvents: Stream.fromArray(events).pipe(
        Stream.ensuring(Deferred.succeed(allEventsEnqueued, undefined)),
      ),
      dispatch: (command: { readonly type: string; readonly threadId: ThreadId }) =>
        Effect.suspend(() => {
          if (command.type === "thread.report.post") {
            reportDispatches.push(command.threadId);
            return options.reportDispatchFails === true
              ? Effect.fail({ _tag: "StubDispatchError" as const, message: "dispatch failed" })
              : Effect.void;
          }
          if (command.type === "thread.turn.start") {
            parentTurns.push(command.threadId);
          }
          return Effect.void;
        }),
    } as unknown as typeof OrchestrationEngineService.Service;

    const shell = (threadId: ThreadId): OrchestrationThreadShell =>
      ({
        id: threadId,
        projectId: PROJECT_ID,
        title: threadId === CHILD_THREAD_ID ? "Spawned worker" : "Parent",
        spawnedByThreadId:
          threadId === CHILD_THREAD_ID
            ? options.spawnedByThreadId === undefined
              ? PARENT_THREAD_ID
              : options.spawnedByThreadId
            : null,
        runtimeMode: "auto",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        settledAt: null,
        session: null,
      }) as unknown as OrchestrationThreadShell;

    const snapshotQuery = {
      getThreadShellById: (threadId: ThreadId) => Effect.sync(() => Option.some(shell(threadId))),
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.sync(() =>
          Option.some({
            ...shell(threadId),
            messages: [],
            activities: [],
            reports: Array.from({ length: options.existingReports ?? 0 }, (_unused, index) => ({
              reportId: `existing-${index}`,
            })),
          } as unknown as OrchestrationThread),
        ),
    } as unknown as typeof ProjectionSnapshotQuery.Service;

    yield* Effect.gen(function* () {
      const reactor = yield* makeSessionSpawnReactor.pipe(
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(ProjectionSnapshotQuery, snapshotQuery),
        // Queued-turn release and provider liveness belong to the delivery-mode
        // and grace-stop features; this file only exercises terminal reporting,
        // so they are stubbed empty rather than simulated.
        Effect.provideService(ProjectionTurnRepository, {
          listQueuedTurnStarts: Effect.succeed([]),
        } as unknown as ProjectionTurnRepositoryShape),
        Effect.provideService(ProviderService, {
          listSessions: () => Effect.succeed([]),
        } as unknown as ProviderService["Service"]),
      );
      yield* reactor.start();
      yield* Deferred.await(allEventsEnqueued);
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

    return { reportDispatches, parentTurns };
  });

it.live("synthesizes one terminal report per episode", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([
      sessionSetEvent("stopped", 1),
      sessionSetEvent("stopped", 2),
    ]);

    expect(result.reportDispatches).toEqual([CHILD_THREAD_ID]);
  }),
);

it.live("retries on a later event when the terminal report dispatch never landed", () =>
  Effect.gen(function* () {
    // Regression: marking the episode before the dispatch succeeded left the
    // thread branded "handled" with nothing persisted, and the parent was
    // never told. The second event must still try.
    const result = yield* runReactor([sessionSetEvent("stopped", 1), sessionSetEvent("error", 2)], {
      reportDispatchFails: true,
    });

    // 3 attempts (1 + 2 retries) for the first event, then the second event
    // tries again because the episode was never marked.
    expect(result.reportDispatches).toHaveLength(6);
    expect(result.parentTurns).toEqual([]);
  }),
);

it.live("leaves a child that already reported alone", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([sessionSetEvent("stopped", 1)], { existingReports: 1 });

    expect(result.reportDispatches).toEqual([]);
  }),
);

it.live("does not synthesize a terminal report for a thread nobody spawned", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([sessionSetEvent("stopped", 1)], { spawnedByThreadId: null });

    expect(result.reportDispatches).toEqual([]);
  }),
);
