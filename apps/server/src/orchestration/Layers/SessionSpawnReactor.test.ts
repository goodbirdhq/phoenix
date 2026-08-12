import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SESSION_REPORT_INLINE_MAX_CHARS,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThread,
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
import {
  buildTerminalReportSummary,
  formatReportMessage,
  makeSessionSpawnReactor,
  terminalReportStatus,
  terminalReportTitle,
} from "./SessionSpawnReactor.ts";

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
    getThreadShellById: (threadId: string) =>
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
        yield* TestClock.setTime(Date.parse(NOW));
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

  it.effect("does not recover a stale running session with a live provider binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const { commands, queuedRows } = yield* createHarness({
          status: "running",
          queued: [queued("live")],
          updatedAt: STALE,
          live: true,
        });
        expect(commands.some((command) => command.type === "thread.session.set")).toBe(false);
        expect(commands.some((command) => command.type === "thread.turn.start.queued")).toBe(false);
        expect(queuedRows).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("cancels and stops when an interrupt replacement exceeds its deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
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

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const report = (overrides: Partial<Parameters<typeof formatReportMessage>[1]> = {}) => ({
  reportId: "report-1",
  threadId: ThreadId.make("thread-1"),
  status: "success" as const,
  title: "Did the work",
  summary: "All tasks completed.",
  artifacts: [],
  origin: "agent" as const,
  createdAt: CREATED_AT,
  ...overrides,
});

const message = (
  id: string,
  role: "assistant" | "user",
  text: string,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const threadDetail = (overrides: Partial<OrchestrationThread>): OrchestrationThread =>
  ({
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Spawned worker",
    messages: [],
    activities: [],
    reports: [],
    ...overrides,
  }) as OrchestrationThread;

describe("terminalReportStatus", () => {
  it("calls a stop partial and a provider error a failure", () => {
    // A stop is an external decision with unknown progress; an error is the
    // session failing outright.
    expect(terminalReportStatus("stopped")).toBe("partial");
    expect(terminalReportStatus("error")).toBe("failure");
  });

  it("titles the report after how the session ended", () => {
    expect(terminalReportTitle("stopped")).toContain("stopped");
    expect(terminalReportTitle("error")).toContain("failed");
  });
});

describe("formatReportMessage", () => {
  it("attributes an agent-posted report to the child", () => {
    const text = formatReportMessage("Spawned worker", report());
    expect(text).toContain('Spawned session "Spawned worker" posted a success report');
    expect(text).not.toContain("Phoenix generated");
  });

  it("never lets a synthesized report read as if the child wrote it", () => {
    const text = formatReportMessage(
      "Spawned worker",
      report({ origin: "system", status: "partial", title: "Session stopped before reporting" }),
    );
    expect(text).toContain("ended without posting a report");
    expect(text).toContain("Phoenix generated a partial report");
  });

  it("lists artifacts with their labels", () => {
    const text = formatReportMessage(
      "Spawned worker",
      report({
        artifacts: [
          { kind: "url", value: "https://example.test/pr/1", label: "PR" },
          { kind: "branch", value: "feature/work" },
        ],
      }),
    );
    expect(text).toContain("- url: https://example.test/pr/1 (PR)");
    expect(text).toContain("- branch: feature/work");
  });

  it("inlines reports at or under the envelope threshold whole", () => {
    const summary = "s".repeat(SESSION_REPORT_INLINE_MAX_CHARS);
    const text = formatReportMessage("Spawned worker", report({ summary }));
    expect(text).toContain(summary);
    expect(text).not.toContain("read_report");
  });

  it("delivers large reports as a compact envelope pointing at read_report", () => {
    const summary = "s".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1);
    const text = formatReportMessage(
      "Spawned worker",
      report({ summary, abstract: "The short version." }),
    );
    expect(text).toContain("The short version.");
    expect(text).not.toContain(summary);
    expect(text).toContain(`Full report is ${summary.length} chars`);
    expect(text).toContain('read_report with reportId "report-1"');
  });

  it("envelopes oversized synthesized reports exactly like agent reports", () => {
    const summary = "z".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1);
    const text = formatReportMessage("Spawned worker", report({ origin: "system", summary }));
    expect(text).toContain("Phoenix generated");
    expect(text).not.toContain(summary);
    expect(text).toContain('read_report with reportId "report-1"');
  });

  it("keeps artifacts and structured counts visible in envelope deliveries", () => {
    const text = formatReportMessage(
      "Spawned worker",
      report({
        summary: "a".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1),
        recommendation: "Merge after CI.",
        findings: [{ title: "Loose type", severity: "low" }],
        validation: { performed: ["typecheck"], gaps: ["no e2e", "no perf run"] },
        artifacts: [{ kind: "url", value: "https://example.test/pr/1", label: "PR" }],
      }),
    );
    expect(text).toContain("- url: https://example.test/pr/1 (PR)");
    expect(text).toContain("Recommendation: Merge after CI.");
    expect(text).toContain("1 finding, 2 validation gaps");
  });
});

describe("buildTerminalReportSummary", () => {
  it("says the session was stopped and flags the work as unfinished", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "stopped",
      lastError: null,
      detail: Option.none(),
    });
    expect(summary).toContain("generated by Phoenix");
    expect(summary).toContain("stopped before it posted a report");
    expect(summary).toContain("Work is likely unfinished");
  });

  it("carries the provider error into the summary", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "error",
      lastError: "provider exited with code 1",
      detail: Option.none(),
    });
    expect(summary).toContain("provider exited with code 1");
  });

  it("reports the last tool activity and assistant message", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "stopped",
      lastError: null,
      detail: Option.some(
        threadDetail({
          messages: [
            message("message-1", "assistant", "Refactored   the parser\nand ran tests"),
            message("message-2", "user", "keep going"),
          ],
          activities: [
            {
              id: "event-1",
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran `pnpm typecheck`",
              payload: {},
              turnId: null,
              createdAt: CREATED_AT,
            },
          ] as unknown as OrchestrationThread["activities"],
        }),
      ),
    });
    expect(summary).toContain("tool.completed: Ran `pnpm typecheck`");
    // Whitespace is collapsed so a multi-line message stays one summary line.
    expect(summary).toContain("Last assistant message: Refactored the parser and ran tests");
  });

  it("is explicit when there is nothing to report rather than silently empty", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "error",
      lastError: null,
      detail: Option.some(threadDetail({})),
    });
    expect(summary).toContain("No recorded tool activity.");
    expect(summary).toContain("No assistant message was produced.");
  });
});
