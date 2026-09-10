import * as QueuedDelivery from "../QueuedDelivery.ts";
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

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
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

const sessionSetEvent = (
  status: "stopped" | "error",
  index: number,
  sessionOverrides: Record<string, unknown> = {},
): OrchestrationEvent =>
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
        ...sessionOverrides,
      },
    },
  }) as unknown as OrchestrationEvent;

const reportPostedEvent = (origin: "agent" | "system", index: number): OrchestrationEvent =>
  ({
    eventId: EventId.make(`event-report-${index}`),
    sequence: index,
    aggregateKind: "thread",
    aggregateId: CHILD_THREAD_ID,
    occurredAt: CREATED_AT,
    type: "thread.report-posted",
    payload: {
      threadId: CHILD_THREAD_ID,
      report: {
        reportId: `report-${index}`,
        threadId: CHILD_THREAD_ID,
        status: origin === "system" ? "partial" : "success",
        title: "Report",
        summary: "Body of the report.",
        artifacts: [],
        origin,
        createdAt: CREATED_AT,
      },
      updatedAt: CREATED_AT,
    },
  }) as unknown as OrchestrationEvent;

interface HarnessOptions {
  // Every dispatch of the synthesized report fails, as a transient infra
  // failure or a decider rejection would.
  readonly reportDispatchFails?: boolean;
  // The child already has an agent-posted report.
  readonly existingReports?: number;
  readonly spawnedByThreadId?: ThreadId | null;
  readonly reportDelivery?: "queue" | "notify-only";
}

const runReactor = (events: ReadonlyArray<OrchestrationEvent>, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const reportDispatches: Array<string> = [];
    const parentTurns: Array<string> = [];
    const parentMessages: Array<{ readonly threadId: string; readonly text: string }> = [];
    // Deterministic hand-off instead of sleeping: resolves once the stream has
    // handed every event to the reactor's worker.
    const allEventsEnqueued = yield* Deferred.make<void>();

    const engine = {
      subscribeDomainEvents: Effect.succeed(
        Stream.fromArray(events).pipe(
          Stream.ensuring(Deferred.succeed(allEventsEnqueued, undefined)),
        ),
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
            parentMessages.push({
              threadId: command.threadId,
              text:
                (command as { readonly message?: { readonly text?: string } }).message?.text ?? "",
            });
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
        reportDelivery: threadId === CHILD_THREAD_ID ? (options.reportDelivery ?? null) : null,
      }) as unknown as OrchestrationThreadShell;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: CREATED_AT,
        }),
      getThreadShellById: (threadId: ThreadId) => Effect.sync(() => Option.some(shell(threadId))),
      getLatestUsageActivity: () => Effect.succeed(Option.none()),
      getThreadTurnCount: () => Effect.succeed(null),
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.sync(() =>
          Option.some({
            ...shell(threadId),
            messages: [],
            activities: [],
            reports: Array.from({ length: options.existingReports ?? 0 }, (_unused, index) => ({
              reportId: `existing-${index}`,
              threadId: CHILD_THREAD_ID,
              status: "success" as const,
              title: "Existing report",
              summary: "Existing report body.",
              artifacts: [],
              origin: "agent" as const,
              createdAt: CREATED_AT,
            })),
          } as unknown as OrchestrationThread),
        ),
    } as unknown as typeof ProjectionSnapshotQuery.Service;

    yield* Effect.gen(function* () {
      const reactor = yield* makeSessionSpawnReactor.pipe(
        Effect.provide(QueuedDelivery.layer),
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
        // Shells here have no worktree, so the death notice never inspects git.
        Effect.provideService(GitWorkflowService.GitWorkflowService, {
          status: () => Effect.die("git status unused in this harness"),
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      );
      yield* reactor.start();
      yield* Deferred.await(allEventsEnqueued);
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

    return { reportDispatches, parentTurns, parentMessages };
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

it.live("does not let a report from an earlier episode suppress terminal synthesis", () =>
  Effect.gen(function* () {
    const result = yield* runReactor(
      [sessionSetEvent("error", 1, { episodeStartedAt: "2026-02-01T00:00:00.000Z" })],
      { existingReports: 1 },
    );

    expect(result.reportDispatches).toEqual([CHILD_THREAD_ID]);
    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.text).not.toContain("already posted a report");
  }),
);

it.live("does not synthesize a terminal report for a thread nobody spawned", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([sessionSetEvent("stopped", 1)], { spawnedByThreadId: null });

    expect(result.reportDispatches).toEqual([]);
  }),
);

it.live("wakes the parent with a typed death notice when the child errors", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([sessionSetEvent("error", 1)]);

    expect(result.reportDispatches).toEqual([CHILD_THREAD_ID]);
    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.threadId).toBe(PARENT_THREAD_ID);
    expect(result.parentMessages[0]?.text).toContain("exit reason: provider_error");
    expect(result.parentMessages[0]?.text).toContain("provider exited");
    expect(result.parentMessages[0]?.text).toContain(CHILD_THREAD_ID);
  }),
);

it.live("still sends the death notice when the child had already reported", () =>
  Effect.gen(function* () {
    // The persisted report suppresses the SYNTHESIZED report, not the death:
    // a child that reported at 30% and then crashed used to die silently.
    const result = yield* runReactor([sessionSetEvent("stopped", 1)], { existingReports: 1 });

    expect(result.reportDispatches).toEqual([]);
    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.text).toContain("already posted a report");
  }),
);

it.live("suppresses the death notice when the parent initiated the stop", () =>
  Effect.gen(function* () {
    // Every settle/stop_session would otherwise wake the parent with news of
    // the death it just caused. The durable report is still synthesized.
    const result = yield* runReactor([
      sessionSetEvent("stopped", 1, { stoppedBy: "parent", stopReason: "parent_stopped" }),
    ]);

    expect(result.reportDispatches).toEqual([CHILD_THREAD_ID]);
    expect(result.parentMessages).toEqual([]);
  }),
);

it.live("names quota exhaustion so the parent can re-route instead of retrying", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([
      sessionSetEvent("error", 1, { lastErrorKind: "usage-limit" }),
    ]);

    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.text).toContain("exit reason: usage_limit");
    expect(result.parentMessages[0]?.text).toContain("list_session_providers");
  }),
);

it.live("delivers the death notice even to a notify-only parent", () =>
  Effect.gen(function* () {
    // reportDelivery opts out of report chatter, not out of learning the
    // child died.
    const result = yield* runReactor([sessionSetEvent("error", 1)], {
      reportDelivery: "notify-only",
    });

    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.text).toContain("exit reason: provider_error");
  }),
);

it.live("never delivers a system-origin report as a second message", () =>
  Effect.gen(function* () {
    // The death notice is the single wake for a termination; the synthesized
    // report's own posted event must not start a second parent turn.
    const result = yield* runReactor([reportPostedEvent("system", 1)]);

    expect(result.parentMessages).toEqual([]);
  }),
);

it.live("still delivers an agent-origin report as a message", () =>
  Effect.gen(function* () {
    const result = yield* runReactor([reportPostedEvent("agent", 1)]);

    expect(result.parentMessages).toHaveLength(1);
    expect(result.parentMessages[0]?.threadId).toBe(PARENT_THREAD_ID);
    expect(result.parentMessages[0]?.text).toContain("posted a success report");
  }),
);
