import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const POSTED_AT = "2026-01-01T01:00:00.000Z";

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
            createdAt: POSTED_AT,
          },
          updatedAt: POSTED_AT,
        });
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
});
