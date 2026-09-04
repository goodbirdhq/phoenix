import {
  CommandId,
  EventId,
  isSessionReportNotificationActivity,
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

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
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
  formatQueuedReportWarning,
  formatReportMessage,
  makeSessionSpawnReactor,
  parseReportDeliveryMessageId,
  reportNotificationActivity,
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
  reportDelivery: OrchestrationThreadShell["reportDelivery"] = null,
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
  reportDelivery,
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
  state: "queued",
  requestedAt,
  releasingAt: null,
  redeliveryCount: 0,
});

const releasing = (suffix: string, releasingAt = STALE): ProjectionQueuedTurnStart => ({
  ...queued(suffix),
  state: "releasing",
  releasingAt,
});

const interrupting = (suffix: string): ProjectionQueuedTurnStart => ({
  ...queued(suffix, "interrupt"),
  state: "interrupting",
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

const queuedReportPostedEvent = (): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("event-report-posted"),
  aggregateKind: "thread",
  aggregateId: CHILD_ID,
  occurredAt: NOW,
  commandId: CommandId.make("command-report-posted"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.report-posted",
  payload: {
    threadId: CHILD_ID,
    report: {
      reportId: "report-queued-warning",
      threadId: CHILD_ID,
      status: "success",
      title: "Done",
      summary: "The report was written first.",
      artifacts: [],
      origin: "agent",
      createdAt: NOW,
    },
    updatedAt: NOW,
  },
});

const createHarness = Effect.fn("createSessionSpawnReactorHarness")(function* (input: {
  readonly status: NonNullable<OrchestrationThreadShell["session"]>["status"];
  readonly queued: ReadonlyArray<ProjectionQueuedTurnStart>;
  readonly live?: boolean;
  readonly updatedAt?: string;
  readonly boundaryEvents?: ReadonlyArray<OrchestrationEvent>;
  readonly queuedRowsRef?: Ref.Ref<Array<ProjectionQueuedTurnStart>>;
  readonly queuedMessageText?: string;
  readonly queuedMessageCreatedAt?: string;
  readonly queuedMessages?: Readonly<
    Record<string, { readonly text: string; readonly createdAt: string }>
  >;
  readonly reportDelivery?: OrchestrationThreadShell["reportDelivery"];
  readonly reports?: OrchestrationThread["reports"];
}) {
  const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
  const queuedRows = input.queuedRowsRef ?? (yield* Ref.make([...input.queued]));
  const childShell = yield* Ref.make(
    makeShell(CHILD_ID, input.status, input.updatedAt, input.reportDelivery ?? null),
  );
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
        if (command.type === "thread.turn.queue.requeue") {
          yield* Ref.update(queuedRows, (entries) =>
            entries.map((entry) =>
              entry.messageId === command.messageId && entry.state === "releasing"
                ? {
                    ...entry,
                    state: "queued",
                    releasingAt: null,
                    redeliveryCount: entry.redeliveryCount + 1,
                  }
                : entry,
            ),
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
    getThreadDetailById: (threadId: string) =>
      threadId === CHILD_ID
        ? Ref.get(childShell).pipe(
            Effect.map((shell) =>
              Option.some({
                ...shell,
                reports: input.reports ?? [],
                messages:
                  input.queuedMessageText === undefined
                    ? []
                    : [
                        {
                          id: input.queued[0]?.messageId ?? MessageId.make("queued-message"),
                          role: "user",
                          text: input.queuedMessageText,
                          attachments: [],
                          turnId: null,
                          streaming: false,
                          createdAt: NOW,
                          updatedAt: NOW,
                        },
                      ],
              } as unknown as OrchestrationThread),
            ),
          )
        : Effect.succeed(Option.none()),
    getThreadMessageById: (_threadId: ThreadId, messageId: MessageId) =>
      Effect.sync(() => {
        const configured = input.queuedMessages?.[messageId];
        return configured !== undefined
          ? Option.some({ role: "user" as const, ...configured })
          : input.queuedMessageText !== undefined && input.queued[0]?.messageId === messageId
            ? Option.some({
                role: "user" as const,
                text: input.queuedMessageText,
                createdAt: input.queuedMessageCreatedAt ?? NOW,
              })
            : Option.none();
      }),
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

  // Shells in this harness have no worktree, so the death-notice risk check
  // never reaches git; dying here catches any test that starts to.
  const gitWorkflow = GitWorkflowService.GitWorkflowService.of({
    status: () => Effect.die("git status unused in this harness"),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"]);

  const reactor = yield* makeSessionSpawnReactor.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, snapshot),
    Effect.provideService(ProjectionTurnRepository, turns),
    Effect.provideService(ProviderService, provider),
    Effect.provideService(GitWorkflowService.GitWorkflowService, gitWorkflow),
  );
  yield* reactor.start();
  yield* Effect.yieldNow;
  yield* reactor.drain;
  yield* Effect.yieldNow;
  yield* reactor.drain;
  return {
    commands: yield* Ref.get(commands),
    queuedRows: yield* Ref.get(queuedRows),
    queuedRowsRef: queuedRows,
  };
});

describe("SessionSpawnReactor queued delivery", () => {
  it.effect("releases a queued user message that quotes a report envelope", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [queued("quoted")],
        queuedMessageText:
          '[Phoenix] Spawned session "Child" posted a success report: Done\n\nSummary.\n\n(spawned thread: child-thread)',
      }).pipe(
        Effect.map(({ commands }) => {
          expect(
            commands.filter((command) => command.type === "thread.turn.queue.cancel"),
          ).toHaveLength(0);
          expect(
            commands.filter((command) => command.type === "thread.turn.start.queued"),
          ).toHaveLength(1);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

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

  it.effect("cancels every undelivered row at a terminal boundary", () =>
    Effect.scoped(
      createHarness({
        status: "stopped",
        queued: [queued("cancel"), interrupting("interrupting"), releasing("in-flight")],
      }).pipe(
        Effect.map(({ commands, queuedRows }) => {
          const cancelled = commands.filter(
            (command) => command.type === "thread.turn.queue.cancel",
          );
          expect(cancelled).toHaveLength(3);
          expect(cancelled.map((command) => command.messageId)).toEqual([
            MessageId.make("queued-cancel"),
            MessageId.make("queued-interrupting"),
            MessageId.make("queued-in-flight"),
          ]);
          expect(queuedRows).toEqual([]);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("requeues stale releasing rows after a fresh reactor starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const first = yield* createHarness({ status: "running", queued: [releasing("stale")] });
        expect(
          first.commands.filter((command) => command.type === "thread.turn.start.queued"),
        ).toHaveLength(0);
        const restarted = yield* createHarness({
          status: "ready",
          queued: [],
          queuedRowsRef: first.queuedRowsRef,
        });
        expect(
          restarted.commands.filter((command) => command.type === "thread.turn.start.queued"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("cancels a releasing row after the durable redelivery limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const harness = yield* createHarness({
          status: "ready",
          queued: [{ ...releasing("limit"), redeliveryCount: 3 }],
        });
        const cancelled = harness.commands.filter(
          (command) => command.type === "thread.turn.queue.cancel",
        );
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]?.type === "thread.turn.queue.cancel" && cancelled[0].reason).toBe(
          "redelivery_limit_reached",
        );
        const notes = harness.commands.filter(
          (command) => command.type === "thread.activity.append",
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]?.type === "thread.activity.append" && notes[0].activity.kind).toBe(
          "queued-delivery.wedged",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect(
    "wakes the parent with a wedge notice when the redelivery limit cancels a message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const harness = yield* createHarness({
            status: "ready",
            queued: [{ ...releasing("limit"), redeliveryCount: 3 }],
          });
          // The error activity lands on the wedged child's own thread where
          // nobody looks; the parent holding the spawn slot gets a message.
          const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
          expect(turns).toHaveLength(1);
          const turn = turns[0];
          if (turn?.type !== "thread.turn.start") throw new Error("expected a turn start");
          expect(turn.threadId).toBe(PARENT_ID);
          expect(turn.message.text).toContain("WEDGED");
          expect(turn.message.text).toContain("queued-limit");
          expect(turn.message.text).toContain(CHILD_ID);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("appends the unconsumed-queue warning when a report outruns waiting messages", () =>
    Effect.scoped(
      createHarness({
        status: "running",
        live: true,
        queued: [queued("waiting")],
        boundaryEvents: [queuedReportPostedEvent()],
      }).pipe(
        Effect.map(({ commands }) => {
          const turns = commands.filter((command) => command.type === "thread.turn.start");
          expect(turns).toHaveLength(1);
          const turn = turns[0];
          if (turn?.type !== "thread.turn.start") throw new Error("expected a turn start");
          expect(turn.message.text).toContain("not consumed before this report was written");
          expect(turn.message.text).toContain("queued-waiting");
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("records a report notification without changing queued user-message delivery", () =>
    Effect.scoped(
      createHarness({
        status: "running",
        live: true,
        queued: [queued("waiting"), releasing("releasing", NOW)],
        boundaryEvents: [queuedReportPostedEvent()],
      }).pipe(
        Effect.map(({ commands }) => {
          const notifications = commands.filter(
            (
              command,
            ): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "session-report.posted",
          );
          expect(notifications).toHaveLength(1);
          expect(notifications[0]?.activity.payload).toMatchObject({
            reportId: "report-queued-warning",
            childThreadId: CHILD_ID,
          });
          // The parent is mid-turn, so the report is handed over as an
          // ordinary turn start and the decider queues it behind that turn —
          // the same path a human message takes into a busy session.
          const delivery = commands.filter((command) => command.type === "thread.turn.start");
          expect(delivery).toHaveLength(1);
          expect(delivery[0]?.type === "thread.turn.start" && delivery[0].threadId).toBe(PARENT_ID);
        }),
        Effect.provide(NodeServices.layer),
      ),
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

  it.effect("cancels and reports a stale release even while its provider binding stays live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const { commands, queuedRows } = yield* createHarness({
          status: "running",
          queued: [releasing("live-wedge")],
          updatedAt: STALE,
          live: true,
        });
        const cancellation = commands.find(
          (command) => command.type === "thread.turn.queue.cancel",
        );
        expect(cancellation?.type === "thread.turn.queue.cancel" && cancellation.reason).toBe(
          "delivery_stalled",
        );
        expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
        expect(queuedRows).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("wakes the parent once when several messages hit the wedge limit together", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const { commands } = yield* createHarness({
          status: "ready",
          queued: [
            { ...releasing("limit-one"), redeliveryCount: 3 },
            { ...releasing("limit-two"), redeliveryCount: 3 },
          ],
        });
        expect(
          commands.filter((command) => command.type === "thread.turn.queue.cancel"),
        ).toHaveLength(2);
        expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
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
  it("adds one pull-first warning when a report predates queued messages", () => {
    const text = formatQueuedReportWarning([
      MessageId.make("queued-a"),
      MessageId.make("queued-b"),
    ]);
    expect(text).toContain("2 queued messages were not consumed before this report was written");
    expect(text).toContain("queued-a, queued-b");
  });
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

  it("leads an amending report with what it supersedes", () => {
    const text = formatReportMessage(
      "Spawned worker",
      report({
        supersedesReportId: "report-original",
        title: "Also handled the late instruction",
      }),
    );
    // The parent may already have acted on the superseded report, so the
    // amendment has to announce itself before the summary it looks like.
    expect(text).toContain("AMENDED report (supersedes report-original)");
    expect(text.indexOf("AMENDED report")).toBeLessThan(text.indexOf("posted a success report"));
  });

  it("keeps the amendment lead on an envelope-sized report", () => {
    const summary = "s".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1);
    const text = formatReportMessage(
      "Spawned worker",
      report({ summary, abstract: "The short version.", supersedesReportId: "report-original" }),
    );
    expect(text).toContain("AMENDED report (supersedes report-original)");
    expect(text).toContain('read_report with reportId "report-1"');
  });

  it("says nothing about amendment for an ordinary report", () => {
    expect(formatReportMessage("Spawned worker", report())).not.toContain("AMENDED");
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

const reportPostedEvent = (
  posted: ReturnType<typeof report>,
  sequence: number,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-report-${posted.reportId}`),
  aggregateKind: "thread",
  aggregateId: CHILD_ID,
  occurredAt: CREATED_AT,
  commandId: CommandId.make(`command-report-${posted.reportId}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.report-posted",
  payload: {
    threadId: CHILD_ID,
    report: { ...posted, threadId: CHILD_ID },
    updatedAt: CREATED_AT,
  },
});

// Reports are durable parent activity, never synthetic parent user messages.
// The provider can pull full truth with read_report/read_session when it is
// explicitly asked to act, instead of being turned once per report burst.
describe("SessionSpawnReactor report notifications", () => {
  const deliveredToParent = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands
      .filter((command) => command.type === "thread.activity.append")
      .filter((command) => command.threadId === PARENT_ID)
      .map((command) => (command.type === "thread.activity.append" ? command.activity : undefined))
      .filter(isSessionReportNotificationActivity);

  it.effect("records an amending report with its supersession link", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: [
          reportPostedEvent(
            report({
              reportId: "report-amendment",
              title: "Also handled the late instruction",
              summary: "The queued instruction arrived after the first report; it is done now.",
              supersedesReportId: "report-original",
            }),
            2,
          ),
        ],
      }).pipe(
        Effect.map(({ commands }) => {
          const delivered = deliveredToParent(commands);
          expect(delivered).toHaveLength(1);
          expect(delivered[0]?.kind).toBe("session-report.posted");
          expect(delivered[0]?.payload).toMatchObject({
            reportId: "report-amendment",
            childThreadId: CHILD_ID,
            supersedesReportId: "report-original",
            origin: "agent",
          });
          // An amendment is a new account of the work, so it is delivered like
          // any other report rather than only updating the inbox row.
          const delivery = commands.filter((command) => command.type === "thread.turn.start");
          expect(delivery).toHaveLength(1);
          expect(delivery[0]?.type === "thread.turn.start" && delivery[0].message.text).toContain(
            "AMENDED report (supersedes report-original)",
          );
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("delivers every report in a six-report burst to the parent", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: Array.from({ length: 6 }, (_unused, index) =>
          reportPostedEvent(report({ reportId: `report-${index + 1}` }), index + 2),
        ),
      }).pipe(
        Effect.map(({ commands }) => {
          const delivered = deliveredToParent(commands);
          expect(delivered).toHaveLength(6);
          expect(delivered.map((entry) => entry?.payload.reportId)).toEqual([
            "report-1",
            "report-2",
            "report-3",
            "report-4",
            "report-5",
            "report-6",
          ]);
          // Every report is also handed to the parent. The parent only ever
          // runs one turn at a time, so the decider queues the rest behind the
          // first; a burst costs the parent turns, which is why a caller that
          // does not want that spawns with "notify-only".
          const delivery = commands.filter((command) => command.type === "thread.turn.start");
          expect(delivery).toHaveLength(6);
          const deliveredMessageIds = delivery.map((command) =>
            command.type === "thread.turn.start" ? command.message.messageId : undefined,
          );
          expect(new Set(deliveredMessageIds).size).toBe(6);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("records the notification but wakes nobody when delivery is notify-only", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        reportDelivery: "notify-only",
        boundaryEvents: [reportPostedEvent(report({ reportId: "report-quiet" }), 2)],
      }).pipe(
        Effect.map(({ commands }) => {
          const delivered = deliveredToParent(commands);
          expect(delivered).toHaveLength(1);
          expect(delivered[0]?.payload).toMatchObject({ reportId: "report-quiet" });
          expect(commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
            0,
          );
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("reuses one delivery command id when a report event is replayed", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: [
          reportPostedEvent(report({ reportId: "report-replayed" }), 2),
          reportPostedEvent(report({ reportId: "report-replayed" }), 2),
        ],
      }).pipe(
        Effect.map(({ commands }) => {
          // Deterministic command ids are what make redelivery after a crash
          // idempotent: the engine receipts the first one and the replay is a
          // no-op rather than a second copy of the report.
          const deliveryIds = commands
            .filter((command) => command.type === "thread.turn.start")
            .map((command) => command.commandId);
          expect(new Set(deliveryIds).size).toBe(1);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it("reuses the same receipt/activity key after a report event is replayed", () => {
    const posted = report({ reportId: "report-restarted", origin: "system" });
    const first = reportNotificationActivity({
      parentThreadId: PARENT_ID,
      childThreadId: CHILD_ID,
      childTitle: "Child",
      report: { ...posted, threadId: CHILD_ID },
      notifiedAt: NOW,
    });
    const replay = reportNotificationActivity({
      parentThreadId: PARENT_ID,
      childThreadId: CHILD_ID,
      childTitle: "Child",
      report: { ...posted, threadId: CHILD_ID },
      notifiedAt: NOW,
    });
    expect(replay.id).toBe(first.id);
    expect(replay.payload).toMatchObject({
      reportId: "report-restarted",
      reportTitle: posted.title,
      origin: "system",
    });
  });
});

describe("buildTerminalReportSummary", () => {
  it("says the session was stopped and flags the work as unfinished", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "stopped",
      exitReason: "exited",
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
      exitReason: "provider_error",
      lastError: "provider exited with code 1",
      detail: Option.none(),
    });
    expect(summary).toContain("provider exited with code 1");
  });

  it("reports the last tool activity and assistant message", () => {
    const summary = buildTerminalReportSummary({
      sessionStatus: "stopped",
      exitReason: "exited",
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
      exitReason: "provider_error",
      lastError: null,
      detail: Option.some(threadDetail({})),
    });
    expect(summary).toContain("No recorded tool activity.");
    expect(summary).toContain("No assistant message was produced.");
  });
});

const turnStartRequestedEvent = (
  threadId: ThreadId,
  messageId: string,
  origin?: { readonly kind: "phoenix"; readonly threadId: ThreadId },
): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: EventId.make(`event-turn-requested-${messageId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: CommandId.make(`command-turn-requested-${messageId}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-start-requested",
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(origin !== undefined ? { origin } : {}),
      createdAt: NOW,
    },
  }) as unknown as OrchestrationEvent;

describe("parseReportDeliveryMessageId", () => {
  it("recovers the child and report ids from a delivery message id", () => {
    expect(parseReportDeliveryMessageId("session-report-delivery:child-1:report-9")).toEqual({
      childThreadId: "child-1",
      reportId: "report-9",
    });
  });

  it("rejects everything else", () => {
    expect(parseReportDeliveryMessageId("some-random-uuid")).toBeNull();
    expect(parseReportDeliveryMessageId("session-report-delivery:")).toBeNull();
    expect(parseReportDeliveryMessageId("session-report-delivery:child-only")).toBeNull();
    expect(parseReportDeliveryMessageId("session-report-delivery:child-1:")).toBeNull();
  });
});

describe("delivery consumption", () => {
  it.effect("acknowledges a delivered report when the parent turn starts on it", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: [
          turnStartRequestedEvent(PARENT_ID, "session-report-delivery:child-thread:report-42", {
            kind: "phoenix",
            threadId: CHILD_ID,
          }),
        ],
        reports: [
          {
            reportId: "report-42",
            threadId: CHILD_ID,
            status: "success",
            title: "Done",
            summary: "Done.",
            artifacts: [],
            origin: "agent",
            createdAt: NOW,
          },
        ],
      }).pipe(
        Effect.map(({ commands }) => {
          const receipts = commands.filter(
            (
              command,
            ): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "session-report.read",
          );
          expect(receipts).toHaveLength(1);
          // Byte-identical ids to read_report's receipt, so both
          // acknowledgement paths converge on one durable record.
          expect(receipts[0]?.commandId).toBe("session-report-read:parent-thread:report-42");
          expect(receipts[0]?.activity.id).toBe("session-report-read:parent-thread:report-42");
          expect(receipts[0]?.activity.payload).toMatchObject({
            childThreadId: "child-thread",
            reportId: "report-42",
            readByThreadId: PARENT_ID,
          });
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("ignores a report-delivery-shaped message id when the report does not exist", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: [
          turnStartRequestedEvent(PARENT_ID, "session-report-delivery:child-thread:forged-report"),
        ],
      }).pipe(
        Effect.map(({ commands }) => {
          expect(
            commands.filter(
              (command) =>
                command.type === "thread.activity.append" &&
                command.activity.kind === "session-report.read",
            ),
          ).toEqual([]);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

  it.effect("ignores turn starts on ordinary messages", () =>
    Effect.scoped(
      createHarness({
        status: "ready",
        queued: [],
        boundaryEvents: [turnStartRequestedEvent(PARENT_ID, "b47ac10b-user-message")],
      }).pipe(
        Effect.map(({ commands }) => {
          expect(
            commands.filter((command) => command.type === "thread.activity.append"),
          ).toHaveLength(0);
        }),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );
});
