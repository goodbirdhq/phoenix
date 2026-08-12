import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadReportRepositoryLive } from "./ProjectionThreadReports.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import {
  type ProjectionThreadReport,
  ProjectionThreadReportRepository,
} from "../Services/ProjectionThreadReports.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadReportRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const report = (
  overrides: Partial<ProjectionThreadReport> & Pick<ProjectionThreadReport, "reportId">,
): ProjectionThreadReport => ({
  threadId: ThreadId.make("thread-reports"),
  status: "success",
  title: "Did the work",
  summary: "All done.",
  abstract: null,
  artifacts: [],
  origin: "agent",
  supersedesReportId: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  ...overrides,
});

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spawnedByThreadId: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips non-null settlement values through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-settled"),
        projectId: ProjectId.make("project-1"),
        title: "Settled thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spawnedByThreadId: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        snoozedUntil: "2026-03-26T09:00:00.000Z",
        snoozedAt: "2026-03-25T00:00:00.000Z",
        pinnedAt: "2026-03-25T00:00:00.000Z",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const row = Option.getOrNull(persisted);
      if (!row) {
        return yield* Effect.die("Expected settled projection_threads row to exist.");
      }
      assert.strictEqual(row.settledOverride, "settled");
      assert.strictEqual(row.settledAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.snoozedUntil, "2026-03-26T09:00:00.000Z");
      assert.strictEqual(row.snoozedAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.pinnedAt, "2026-03-25T00:00:00.000Z");

      // Un-settle to the keep-active pin and wake the snooze; confirm the
      // flips persist.
      yield* threads.upsert({
        ...row,
        settledOverride: "active",
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
      });
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const updated = Option.getOrNull(repersisted);
      assert.strictEqual(updated?.settledOverride, "active");
      assert.strictEqual(updated?.settledAt, null);
      assert.strictEqual(updated?.snoozedUntil, null);
      assert.strictEqual(updated?.snoozedAt, null);
      assert.strictEqual(updated?.pinnedAt, null);
    }),
  );

  it.effect("resolves an amendment chain from both ends", () =>
    Effect.gen(function* () {
      const reports = yield* ProjectionThreadReportRepository;

      yield* reports.upsert(
        report({
          reportId: "report-original",
          summary: "Shipped the feature.",
          createdAt: "2026-08-12T01:00:00.000Z",
        }),
      );
      yield* reports.upsert(
        report({
          reportId: "report-amendment",
          summary: "Shipped the feature, plus the late instruction.",
          supersedesReportId: "report-original",
          createdAt: "2026-08-12T02:00:00.000Z",
        }),
      );

      // Read from the new end: it names what it replaced, and nothing has
      // replaced it.
      const amendment = Option.getOrNull(
        yield* reports.findByReportId({ reportId: "report-amendment" }),
      );
      assert.strictEqual(amendment?.supersedesReportId, "report-original");
      assert.strictEqual(amendment?.supersededByReportId, undefined);

      // Read from the old end: the reverse link is derived, not stored, so it
      // appears without the original row ever being rewritten.
      const original = Option.getOrNull(
        yield* reports.findByReportId({ reportId: "report-original" }),
      );
      assert.strictEqual(original?.supersedesReportId, null);
      assert.strictEqual(original?.supersededByReportId, "report-amendment");
      // Append-only: the superseded report keeps its own body.
      assert.strictEqual(original?.summary, "Shipped the feature.");

      // The amendment is the thread's latest report, and the list carries the
      // same links as the by-id reads.
      const listed = yield* reports.listByThreadId({
        threadId: ThreadId.make("thread-reports"),
      });
      assert.deepStrictEqual(
        listed.map((entry) => entry.reportId),
        ["report-original", "report-amendment"],
      );
      assert.strictEqual(listed.at(-1)?.reportId, "report-amendment");
      assert.strictEqual(listed[0]?.supersededByReportId, "report-amendment");
    }),
  );

  it.effect("lets a resumed session's agent report supersede a synthesized one", () =>
    Effect.gen(function* () {
      const reports = yield* ProjectionThreadReportRepository;
      const threadId = ThreadId.make("thread-resurrected");

      // The session was stopped, so Phoenix wrote a terminal report for it.
      yield* reports.upsert(
        report({
          reportId: "report-synthetic",
          threadId,
          status: "partial",
          title: "Session stopped before reporting",
          summary: "Phoenix generated this report.",
          origin: "system",
          createdAt: "2026-08-12T01:00:00.000Z",
        }),
      );
      // It came back and finished the work; its own account supersedes the
      // stand-in.
      yield* reports.upsert(
        report({
          reportId: "report-agent",
          threadId,
          summary: "Resumed and finished the work.",
          supersedesReportId: "report-synthetic",
          createdAt: "2026-08-12T02:00:00.000Z",
        }),
      );

      const synthetic = Option.getOrNull(
        yield* reports.findByReportId({ reportId: "report-synthetic" }),
      );
      // Still system-origin and still readable — the parent can see both that
      // Phoenix stood in and that the agent later spoke for itself.
      assert.strictEqual(synthetic?.origin, "system");
      assert.strictEqual(synthetic?.supersededByReportId, "report-agent");

      const listed = yield* reports.listByThreadId({ threadId });
      assert.strictEqual(listed.at(-1)?.reportId, "report-agent");
      assert.strictEqual(listed.at(-1)?.origin, "agent");
    }),
  );

  it.effect("leaves an unamended report with no supersession links", () =>
    Effect.gen(function* () {
      const reports = yield* ProjectionThreadReportRepository;

      yield* reports.upsert(
        report({ reportId: "report-standalone", threadId: ThreadId.make("thread-standalone") }),
      );

      const persisted = Option.getOrNull(
        yield* reports.findByReportId({ reportId: "report-standalone" }),
      );
      assert.strictEqual(persisted?.supersedesReportId, null);
      assert.strictEqual(persisted?.supersededByReportId, undefined);
    }),
  );
});
