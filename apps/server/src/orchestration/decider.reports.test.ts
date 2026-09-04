import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import type { OrchestrationCommandInvariantError } from "./Errors.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const POSTED_AT = "2026-01-01T01:00:00.000Z";

// decideOrchestrationCommand can also fail with a PlatformError, so the
// flipped error is a union; narrow before reading the invariant's detail
// rather than asserting against a field the type does not guarantee.
const invariantDetail = (error: { readonly _tag: string }): string =>
  error._tag === "OrchestrationCommandInvariantError"
    ? (error as OrchestrationCommandInvariantError).detail
    : `expected an OrchestrationCommandInvariantError, received ${error._tag}`;

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Spawned worker",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      reports: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: CREATED_AT,
};

it.layer(NodeServices.layer)("report decider", (it) => {
  it.effect("emits send-to-parent delivery and sender marker in one event batch", () =>
    Effect.gen(function* () {
      const childThreadId = ThreadId.make("child-thread");
      const model = {
        ...readModel,
        threads: [
          readModel.threads[0]!,
          {
            ...readModel.threads[0]!,
            id: childThreadId,
            title: "Child",
            spawnedByThreadId: ThreadId.make("thread-1"),
          },
        ],
      } satisfies OrchestrationReadModel;
      const activity = {
        id: EventId.make("session-message-sent:child-thread:message-parent"),
        tone: "info" as const,
        kind: "session-message.sent" as const,
        summary: "Sent message to parent session; awaiting reply",
        payload: {
          parentThreadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-parent"),
          awaitingReply: true,
          sentAt: POSTED_AT,
        },
        turnId: null,
        createdAt: POSTED_AT,
      };

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-send-parent"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-parent"),
            role: "user",
            text: "Need the SHA",
            attachments: [],
            origin: { kind: "session", threadId: childThreadId },
          },
          linkedActivity: { threadId: childThreadId, activity },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: POSTED_AT,
        },
        readModel: model,
      });

      expect(Array.isArray(result)).toBe(true);
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events[0]?.type === "thread.activity-appended" && events[0].payload.activity).toEqual(
        activity,
      );
      expect(events[2]?.type === "thread.turn-start-requested" && events[2].payload.origin).toEqual(
        { kind: "session", threadId: childThreadId },
      );
    }),
  );

  it.effect("emits thread.report-posted for a posted report", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.report.post",
          commandId: CommandId.make("cmd-report-post"),
          threadId: ThreadId.make("thread-1"),
          reportId: "report-1",
          status: "success",
          title: "Did the work",
          summary: "All tasks completed.",
          artifacts: [{ kind: "branch", value: "feature/spawned-work" }],
          createdAt: POSTED_AT,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          report: {
            reportId: "report-1",
            threadId: ThreadId.make("thread-1"),
            status: "success",
            title: "Did the work",
            summary: "All tasks completed.",
            artifacts: [{ kind: "branch", value: "feature/spawned-work" }],
            origin: "agent",
            createdAt: POSTED_AT,
          },
          updatedAt: POSTED_AT,
        });
      }
    }),
  );

  it.effect("carries optional structured fields through to the event payload", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.report.post",
          commandId: CommandId.make("cmd-report-post-structured"),
          threadId: ThreadId.make("thread-1"),
          reportId: "report-structured-1",
          status: "partial",
          title: "Did most of the work",
          summary: "Two of three tasks completed.",
          artifacts: [],
          findings: [
            { title: "Missing test coverage", severity: "medium", detail: "No integration test." },
          ],
          validation: { performed: ["Ran unit tests"], gaps: ["No e2e run"] },
          recommendation: "Add an integration test before merging.",
          completionPercent: 66,
          createdAt: POSTED_AT,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          report: {
            reportId: "report-structured-1",
            threadId: ThreadId.make("thread-1"),
            status: "partial",
            title: "Did most of the work",
            summary: "Two of three tasks completed.",
            artifacts: [],
            findings: [
              {
                title: "Missing test coverage",
                severity: "medium",
                detail: "No integration test.",
              },
            ],
            validation: { performed: ["Ran unit tests"], gaps: ["No e2e run"] },
            recommendation: "Add an integration test before merging.",
            completionPercent: 66,
            origin: "agent",
            createdAt: POSTED_AT,
          },
          updatedAt: POSTED_AT,
        });
      }
    }),
  );

  it.effect("marks a reactor-synthesized terminal report as system-origin", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.report.post",
          commandId: CommandId.make("cmd-report-post-synthetic"),
          threadId: ThreadId.make("thread-1"),
          reportId: "report-synthetic",
          status: "partial",
          title: "Session stopped before reporting",
          summary: "Phoenix generated this report.",
          artifacts: [],
          origin: "system",
          createdAt: POSTED_AT,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload.report.origin).toBe("system");
        expect(event.payload.report.status).toBe("partial");
      }
    }),
  );

  it.effect("carries an amendment link through to the event payload", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.report.post",
          commandId: CommandId.make("cmd-report-post-amendment"),
          threadId: ThreadId.make("thread-1"),
          reportId: "report-amendment",
          status: "success",
          title: "Also handled the late instruction",
          summary: "The queued instruction arrived after the first report; it is done now.",
          artifacts: [],
          supersedesReportId: "report-1",
          createdAt: POSTED_AT,
        },
        // The superseded report has to exist on the thread: the decider
        // refuses a dangling amendment link.
        readModel: readModelWithReports([{ reportId: "report-1" }]),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload.report.supersedesReportId).toBe("report-1");
        // Only the forward link is recorded: the superseded report keeps its
        // own event, and the reverse link is derived when reports are read.
        expect(event.payload.report.supersededByReportId).toBeUndefined();
      }
    }),
  );

  // A thread that already carries reports, so the decider's supersession
  // check has a folded read model to work against — the same shape command
  // processing sees, which is what makes this check race-proof.
  const readModelWithReports = (
    reports: ReadonlyArray<{ readonly reportId: string; readonly supersedesReportId?: string }>,
  ): OrchestrationReadModel => ({
    ...readModel,
    threads: readModel.threads.map((thread) => ({
      ...thread,
      reports: reports.map((entry) => ({
        reportId: entry.reportId,
        threadId: ThreadId.make("thread-1"),
        status: "success" as const,
        title: "Did the work",
        summary: "All done.",
        artifacts: [],
        origin: "agent" as const,
        ...(entry.supersedesReportId !== undefined
          ? { supersedesReportId: entry.supersedesReportId }
          : {}),
        createdAt: POSTED_AT,
      })),
    })),
  });

  const amendmentCommand = (input: {
    readonly reportId: string;
    readonly supersedesReportId: string;
  }) =>
    ({
      type: "thread.report.post",
      commandId: CommandId.make(`cmd-${input.reportId}`),
      threadId: ThreadId.make("thread-1"),
      reportId: input.reportId,
      status: "success",
      title: "Amended",
      summary: "Amended account.",
      artifacts: [],
      supersedesReportId: input.supersedesReportId,
      createdAt: POSTED_AT,
    }) satisfies Extract<OrchestrationCommand, { type: "thread.report.post" }>;

  it.effect("accepts an amendment of the newest report in a chain", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: amendmentCommand({ reportId: "report-c", supersedesReportId: "report-b" }),
        readModel: readModelWithReports([
          { reportId: "report-a" },
          { reportId: "report-b", supersedesReportId: "report-a" },
        ]),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload.report.supersedesReportId).toBe("report-b");
      }
    }),
  );

  it.effect("refuses to fork a chain by superseding an already-superseded report", () =>
    Effect.gen(function* () {
      // The race, resolved: two amendments of report-a reach the decider; the
      // first produced report-b, so the second is rejected here rather than
      // creating an a→b / a→c fork that no reader could order.
      const result = yield* decideOrchestrationCommand({
        command: amendmentCommand({ reportId: "report-c", supersedesReportId: "report-a" }),
        readModel: readModelWithReports([
          { reportId: "report-a" },
          { reportId: "report-b", supersedesReportId: "report-a" },
        ]),
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      // Actionable: names the winner and where to re-attach.
      expect(invariantDetail(result)).toContain("report-a is already superseded by report-b");
      expect(invariantDetail(result)).toContain("supersede report-b instead");
    }),
  );

  it.effect("points a rejected amendment at the head of a longer chain", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: amendmentCommand({ reportId: "report-d", supersedesReportId: "report-a" }),
        readModel: readModelWithReports([
          { reportId: "report-a" },
          { reportId: "report-b", supersedesReportId: "report-a" },
          { reportId: "report-c", supersedesReportId: "report-b" },
        ]),
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      expect(invariantDetail(result)).toContain("current head of that chain is report-c");
      expect(invariantDetail(result)).toContain("supersede report-c instead");
    }),
  );

  it.effect("refuses an amendment of a report that does not exist on the thread", () =>
    Effect.gen(function* () {
      // The decider is authoritative, so this holds for internally dispatched
      // report posts too — not only ones the toolkit pre-checked.
      const result = yield* decideOrchestrationCommand({
        command: amendmentCommand({ reportId: "report-b", supersedesReportId: "report-missing" }),
        readModel: readModelWithReports([{ reportId: "report-a" }]),
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      expect(invariantDetail(result)).toContain("report-missing");
    }),
  );

  it.effect("lets a real agent report supersede a Phoenix-synthesized one", () =>
    Effect.gen(function* () {
      // Resurrection: the session was stopped, Phoenix synthesized a terminal
      // report, then the session resumed and its agent finished the work. The
      // agent's account must be able to replace the synthesized one.
      const result = yield* decideOrchestrationCommand({
        command: amendmentCommand({
          reportId: "report-agent",
          supersedesReportId: "report-synthetic",
        }),
        readModel: {
          ...readModel,
          threads: readModel.threads.map((thread) => ({
            ...thread,
            reports: [
              {
                reportId: "report-synthetic",
                threadId: ThreadId.make("thread-1"),
                status: "partial" as const,
                title: "Session stopped before reporting",
                summary: "Phoenix generated this report.",
                artifacts: [],
                origin: "system" as const,
                createdAt: CREATED_AT,
              },
            ],
          })),
        },
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.report-posted");
      if (event.type === "thread.report-posted") {
        expect(event.payload.report.supersedesReportId).toBe("report-synthetic");
        // The amendment is the agent speaking; superseding a system report
        // does not inherit its origin.
        expect(event.payload.report.origin).toBe("agent");
      }
    }),
  );

  it.effect("rejects a report for an unknown thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.report.post",
          commandId: CommandId.make("cmd-report-post-missing"),
          threadId: ThreadId.make("thread-missing"),
          reportId: "report-2",
          status: "failure",
          title: "No thread",
          summary: "Should not land.",
          artifacts: [],
          createdAt: POSTED_AT,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("carries the spawn-time report delivery choice onto thread.created", () =>
    Effect.gen(function* () {
      // thread.create requires its project to exist in the read model.
      const readModelWithProject: OrchestrationReadModel = {
        ...readModel,
        projects: [
          {
            id: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project-1",
            defaultModelSelection: null,
            scripts: [],
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            deletedAt: null,
          },
        ],
      };
      const decide = (reportDelivery: "queue" | "notify-only" | undefined) =>
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${reportDelivery ?? "unset"}`),
            threadId: ThreadId.make(`thread-new-${reportDelivery ?? "unset"}`),
            projectId: ProjectId.make("project-1"),
            title: "Spawned worker",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            spawnedByThreadId: ThreadId.make("thread-1"),
            ...(reportDelivery === undefined ? {} : { reportDelivery }),
            createdAt: CREATED_AT,
          },
          readModel: readModelWithProject,
        }).pipe(
          Effect.map((result) => {
            const events = Array.isArray(result) ? result : [result];
            const created = events.find((event) => event.type === "thread.created");
            return created?.type === "thread.created" ? created.payload.reportDelivery : "missing";
          }),
        );

      // The reactor reads this back at report time, and the field is optional,
      // so a dropped value would silently read as the default rather than
      // failing — which is exactly why it is asserted here.
      expect(yield* decide("notify-only")).toBe("notify-only");
      expect(yield* decide("queue")).toBe("queue");
      // Threads nobody configured carry null; the reactor applies the default.
      expect(yield* decide(undefined)).toBeNull();
    }),
  );
});
