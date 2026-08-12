import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProjectionTurnRepository,
  type ProjectionQueuedTurnStart,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import { makeSessionSpawnReactor } from "./SessionSpawnReactor.ts";

const CHILD_ID = ThreadId.make("child-thread");
const PARENT_ID = ThreadId.make("parent-thread");
const NOW = "2026-01-01T00:00:00.000Z";
const STALE = "2020-01-01T00:00:00.000Z";

const makeShell = (
  threadId: ThreadId,
  status: OrchestrationSession["status"],
  updatedAt = NOW,
): OrchestrationThreadShell => ({
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: threadId === CHILD_ID ? "Child" : "Parent",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  spawnedByThreadId: threadId === CHILD_ID ? PARENT_ID : null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: {
    threadId,
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
    lastError: status === "error" ? "provider failed" : null,
    updatedAt,
  },
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const queued = (
  suffix: string,
  mode: ProjectionQueuedTurnStart["mode"] = "queue",
  requestedAt = NOW,
): ProjectionQueuedTurnStart => ({
  threadId: CHILD_ID,
  messageId: MessageId.make(`queued-${suffix}`),
  mode,
  requestedAt,
});

const sessionSetEvent = (shell: OrchestrationThreadShell): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make(`event-${shell.session?.status ?? "none"}`),
  aggregateKind: "thread",
  aggregateId: shell.id,
  occurredAt: shell.session?.updatedAt ?? NOW,
  commandId: CommandId.make("command-session-set"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.session-set",
  payload: {
    threadId: shell.id,
    session: shell.session!,
  },
});

const createHarness = Effect.fn("createSessionSpawnReactorHarness")(function* (input: {
  readonly status: NonNullable<OrchestrationThreadShell["session"]>["status"];
  readonly queued: ReadonlyArray<ProjectionQueuedTurnStart>;
  readonly live?: boolean;
  readonly updatedAt?: string;
  readonly boundaryEvents?: ReadonlyArray<OrchestrationEvent>;
}) {
  const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
  const queuedRows = yield* Ref.make([...input.queued]);
  const childShell = yield* Ref.make(makeShell(CHILD_ID, input.status, input.updatedAt));
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  let sequence = 0;

  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* Ref.update(commands, (entries) => [...entries, command]);
        if (command.type === "thread.turn.start.queued") {
          yield* Ref.update(queuedRows, (entries) =>
            entries.filter((entry) => entry.messageId !== command.messageId),
          );
        }
        if (command.type === "thread.turn.queue.cancel") {
          yield* Ref.update(queuedRows, (entries) =>
            entries.filter((entry) => entry.messageId !== command.messageId),
          );
        }
        if (command.type === "thread.session.set") {
          const shell = { ...(yield* Ref.get(childShell)), session: command.session };
          yield* Ref.set(childShell, shell);
          yield* PubSub.publish(events, sessionSetEvent(shell));
        }
        sequence += 1;
        return { sequence };
      }),
    streamDomainEvents: Stream.merge(
      Stream.fromPubSub(events),
      Stream.fromIterable(input.boundaryEvents ?? []),
    ),
    latestSequence: Effect.sync(() => sequence),
  });
  const snapshot = ProjectionSnapshotQuery.of({
    getThreadShellById: (threadId) =>
      threadId === CHILD_ID
        ? Ref.get(childShell).pipe(Effect.map(Option.some))
        : threadId === PARENT_ID
          ? Effect.succeed(Option.some(makeShell(PARENT_ID, "ready")))
          : Effect.succeed(Option.none()),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const turns = ProjectionTurnRepository.of({
    listQueuedTurnStarts: Ref.get(queuedRows),
  } as unknown as ProjectionTurnRepositoryShape);
  const provider = ProviderService.of({
    listSessions: () =>
      Effect.succeed(
        input.live
          ? ([{ threadId: CHILD_ID } as ProviderSession] as ReadonlyArray<ProviderSession>)
          : [],
      ),
  } as ProviderService["Service"]);

  const reactor = yield* makeSessionSpawnReactor.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, snapshot),
    Effect.provideService(ProjectionTurnRepository, turns),
    Effect.provideService(ProviderService, provider),
  );
  yield* reactor.start();
  yield* Effect.yieldNow;
  yield* reactor.drain;
  yield* Effect.yieldNow;
  yield* reactor.drain;
  return { commands: yield* Ref.get(commands), queuedRows: yield* Ref.get(queuedRows) };
});

describe("SessionSpawnReactor queued delivery", () => {
  it.effect("releases the FIFO head at a ready turn boundary", () =>
    Effect.scoped(
      createHarness({ status: "ready", queued: [queued("first"), queued("second")] }).pipe(
        Effect.map(({ commands }) => {
          const releases = commands.filter(
            (command) => command.type === "thread.turn.start.queued",
          );
          expect(releases).toHaveLength(1);
          expect(releases[0]?.messageId).toBe(MessageId.make("queued-first"));
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("cancels terminal queues without restarting stopped or failed sessions", () =>
    Effect.scoped(
      Effect.forEach(["stopped", "error"] as const, (status) =>
        createHarness({ status, queued: [queued(`${status}-1`), queued(`${status}-2`)] }).pipe(
          Effect.map(({ commands }) => {
            expect(
              commands.filter((command) => command.type === "thread.turn.start.queued"),
            ).toHaveLength(0);
            expect(
              commands.filter((command) => command.type === "thread.turn.queue.cancel"),
            ).toHaveLength(2);
          }),
        ),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("serializes a boundary event with startup recovery and releases only once", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [queued("once")],
        boundaryEvents: [sessionSetEvent(makeShell(CHILD_ID, "ready"))],
      }).pipe(
        Effect.map(({ commands }) => {
          expect(
            commands.filter((command) => command.type === "thread.turn.start.queued"),
          ).toHaveLength(1);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("recovers a stranded running session with no live provider binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(new Date(NOW).getTime());
        const { commands, queuedRows } = yield* createHarness({
          status: "running",
          queued: [queued("stranded")],
          updatedAt: STALE,
        });
        expect(commands.some((command) => command.type === "thread.session.set")).toBe(true);
        expect(commands.some((command) => command.type === "thread.turn.start.queued")).toBe(true);
        expect(queuedRows).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("cancels and stops when an interrupt replacement exceeds its deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(new Date(NOW).getTime());
        const { commands, queuedRows } = yield* createHarness({
          status: "running",
          queued: [queued("interrupt", "interrupt", STALE)],
          live: true,
        });
        expect(commands.some((command) => command.type === "thread.turn.queue.cancel")).toBe(true);
        expect(commands.some((command) => command.type === "thread.session.stop")).toBe(true);
        expect(queuedRows).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
