import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadReportRepositoryLive } from "./ProjectionThreadReports.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import * as ProjectionThreadPullRequests from "../ProjectionThreadPullRequests.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import {
  type ProjectionThreadReport,
  ProjectionThreadReportRepository,
} from "../Services/ProjectionThreadReports.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import {
  ProjectionThreadPullRequestRepository,
  type ProjectionThreadPullRequest,
} from "../ProjectionThreadPullRequests.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepository } from "../Services/ProjectionThreadProposedPlans.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadReportRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadPullRequests.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadProposedPlanRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
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
  it.effect("selects the latest-turn plan before checking implementation status", () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionThreadProposedPlanRepository;
      const threadId = ThreadId.make("thread-plan-status");
      const latestTurnId = TurnId.make("turn-plan-status-current");
      const firstPlan = {
        planId: "plan-status-first",
        threadId,
        turnId: latestTurnId,
        planMarkdown: "# First plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-03-24T00:00:01.000Z",
        updatedAt: "2026-03-24T00:00:01.000Z",
      };
      yield* plans.upsert(firstPlan);
      yield* plans.upsert({
        ...firstPlan,
        planId: "plan-status-implemented",
        implementedAt: "2026-03-24T00:00:02.000Z",
        createdAt: "2026-03-24T00:00:02.000Z",
        updatedAt: "2026-03-24T00:00:02.000Z",
      });
      yield* plans.upsert({
        ...firstPlan,
        planId: "plan-status-other-turn",
        turnId: TurnId.make("turn-plan-status-old"),
        updatedAt: "2026-03-24T00:00:10.000Z",
      });

      assert.isFalse(yield* plans.hasActionableByThreadId({ threadId, latestTurnId }));
      assert.isTrue(yield* plans.hasActionableByThreadId({ threadId, latestTurnId: null }));

      yield* plans.upsert({ ...firstPlan, updatedAt: "2026-03-24T00:00:03.000Z" });
      assert.isTrue(yield* plans.hasActionableByThreadId({ threadId, latestTurnId }));
    }),
  );

  it.effect("falls back within the thread when the latest turn has no plan", () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionThreadProposedPlanRepository;
      const threadId = ThreadId.make("thread-plan-fallback");
      const latestTurnId = TurnId.make("turn-plan-fallback-missing");
      assert.isFalse(yield* plans.hasActionableByThreadId({ threadId, latestTurnId }));
      assert.isFalse(yield* plans.hasActionableByThreadId({ threadId, latestTurnId: null }));

      const firstPlan = {
        planId: "plan-fallback-without-turn",
        threadId,
        turnId: null,
        planMarkdown: "# Old plan",
        implementedAt: "2026-03-24T00:00:01.000Z",
        implementationThreadId: null,
        createdAt: "2026-03-24T00:00:01.000Z",
        updatedAt: "2026-03-24T00:00:01.000Z",
      };
      yield* plans.upsert(firstPlan);
      yield* plans.upsert({
        ...firstPlan,
        planId: "plan-fallback-with-turn",
        turnId: TurnId.make("turn-plan-fallback-old"),
        implementedAt: null,
        updatedAt: "2026-03-24T00:00:02.000Z",
      });
      yield* plans.upsert({
        ...firstPlan,
        planId: "plan-fallback-other-thread",
        threadId: ThreadId.make("thread-plan-fallback-other"),
        turnId: latestTurnId,
        updatedAt: "2026-03-24T00:00:03.000Z",
      });

      assert.isTrue(yield* plans.hasActionableByThreadId({ threadId, latestTurnId }));
      assert.isTrue(yield* plans.hasActionableByThreadId({ threadId, latestTurnId: null }));
    }),
  );

  it.effect("preserves locale ordering and stable ties when selecting plan status", () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionThreadProposedPlanRepository;
      const timestamp = "2026-03-24T00:00:00.000Z";
      const cases = [
        {
          name: "mixed-case-ids",
          expected: "plan-A".localeCompare("plan-a") > 0,
          rows: [
            {
              planId: "plan-a",
              implementedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            { planId: "plan-A", implementedAt: null, createdAt: timestamp, updatedAt: timestamp },
          ],
        },
        {
          name: "equivalent-ids",
          expected: true,
          rows: [
            {
              planId: "plan-\u00e9",
              implementedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              planId: "plan-e\u0301",
              implementedAt: null,
              createdAt: "2026-03-24T00:00:01.000Z",
              updatedAt: timestamp,
            },
          ],
        },
        {
          name: "timestamp-formats",
          expected: "2026-03-24T00:00:00+00:00".localeCompare("2026-03-24T00:00:00-01:00") > 0,
          rows: [
            {
              planId: "plan-minus",
              implementedAt: timestamp,
              createdAt: timestamp,
              updatedAt: "2026-03-24T00:00:00-01:00",
            },
            {
              planId: "plan-plus",
              implementedAt: null,
              createdAt: timestamp,
              updatedAt: "2026-03-24T00:00:00+00:00",
            },
          ],
        },
      ];
      for (const testCase of cases) {
        const threadId = ThreadId.make(`thread-plan-order-${testCase.name}`);
        const latestTurnId = TurnId.make(`turn-plan-order-${testCase.name}`);
        for (const plan of testCase.rows) {
          yield* plans.upsert({
            ...plan,
            planId: `${testCase.name}-${plan.planId}`,
            threadId,
            turnId: latestTurnId,
            planMarkdown: "# Plan",
            implementationThreadId: null,
          });
        }
        assert.strictEqual(
          yield* plans.hasActionableByThreadId({ threadId, latestTurnId }),
          testCase.expected,
          testCase.name,
        );
        assert.strictEqual(
          yield* plans.hasActionableByThreadId({ threadId, latestTurnId: null }),
          testCase.expected,
          testCase.name,
        );
      }
    }),
  );

  it.effect("returns only current-turn status metadata when old plans have large bodies", () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionThreadProposedPlanRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-plan-metadata");
      const latestTurnId = TurnId.make("turn-plan-metadata-current");
      const updatedAt = "2026-03-24T00:00:00.000Z";
      yield* sql`
        WITH RECURSIVE history(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 256
        )
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        )
        SELECT 'plan-metadata-old-' || n, ${threadId}, 'turn-plan-metadata-old',
          ${"# Old plan\n".repeat(1024)}, ${updatedAt}, NULL, ${updatedAt}, ${updatedAt}
        FROM history
      `;
      yield* plans.upsert({
        planId: "plan-metadata-current",
        threadId,
        turnId: latestTurnId,
        planMarkdown: "# Current plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: updatedAt,
        updatedAt,
      });
      const statements: Array<Statement.Statement<unknown>> = [];
      const actionable = yield* plans.hasActionableByThreadId({ threadId, latestTurnId }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          statements.push(statement);
          return Effect.succeed(statement);
        }),
      );
      assert.isTrue(actionable);
      assert.strictEqual(statements.length, 1);
      const statement = statements[0];
      if (statement === undefined) return yield* Effect.die("Expected a plan status query.");
      assert.deepEqual(yield* statement, [
        { planId: "plan-metadata-current", implementedAt: null, updatedAt },
      ]);
    }),
  );

  it.effect("reads only the requested plan in its thread", () =>
    Effect.gen(function* () {
      const plans = yield* ProjectionThreadProposedPlanRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("plan-query-thread");
      const planId = OrchestrationProposedPlanId.make("plan-query-target");
      yield* plans.upsert({
        planId,
        threadId,
        turnId: null,
        planMarkdown: "Keep this plan",
        implementedAt: "2026-03-01T00:01:00.000Z",
        implementationThreadId: ThreadId.make("implementation-thread"),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:01:00.000Z",
      });
      // An unrelated old row must not be loaded or decoded by the exact lookup.
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        ) VALUES (
          'unrelated-plan', ${threadId}, NULL, '', NULL, NULL,
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
        )
      `;
      const plan = Option.getOrThrow(yield* plans.getByPlanId({ threadId, planId }));
      assert.equal(plan.planMarkdown, "Keep this plan");
      assert.equal(plan.implementedAt, "2026-03-01T00:01:00.000Z");
      assert.isTrue(
        Option.isNone(
          yield* plans.getByPlanId({
            threadId: ThreadId.make("another-thread"),
            planId,
          }),
        ),
      );
    }),
  );

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
        autoPull: false,
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
        reportDelivery: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
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
        reportDelivery: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        unsettledAt: null,
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
        unsettledAt: "2026-03-26T00:00:00.000Z",
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
      assert.strictEqual(updated?.unsettledAt, "2026-03-26T00:00:00.000Z");
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

  it.effect("round-trips manual and branch pull requests through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const linkedPullRequest = {
        projectId: ProjectId.make("project-linked-pr"),
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
      };
      const branchPullRequest = {
        ...linkedPullRequest,
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
      };

      yield* threads.upsert({
        threadId: ThreadId.make("thread-linked-pr"),
        projectId: ProjectId.make("project-linked-pr"),
        title: "Linked pull request",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spawnedByThreadId: null,
        reportDelivery: null,
        linkedPullRequest,
        branchPullRequest,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const persisted = yield* threads.getById({ threadId: ThreadId.make("thread-linked-pr") });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.linkedPullRequest, linkedPullRequest);
      assert.deepStrictEqual(Option.getOrNull(persisted)?.branchPullRequest, branchPullRequest);

      const listed = yield* threads.listByProjectId({ projectId: linkedPullRequest.projectId });
      assert.deepStrictEqual(listed[0]?.branchPullRequest, branchPullRequest);

      const row = Option.getOrNull(persisted);
      if (row === null) return yield* Effect.die("Expected linked thread row to exist.");
      yield* threads.upsert({ ...row, linkedPullRequest: null });

      const cleared = yield* threads.getById({ threadId: ThreadId.make("thread-linked-pr") });
      assert.strictEqual(Option.getOrNull(cleared)?.linkedPullRequest, null);
      assert.deepStrictEqual(Option.getOrNull(cleared)?.branchPullRequest, branchPullRequest);

      yield* threads.upsert({ ...row, branchPullRequest: null });
      const branchCleared = yield* threads.getById({ threadId: row.threadId });
      assert.strictEqual(Option.getOrNull(branchCleared)?.branchPullRequest, null);
      assert.deepStrictEqual(Option.getOrNull(branchCleared)?.linkedPullRequest, linkedPullRequest);
    }),
  );

  it.effect("uses one Azure identity for repository writes, lookups, and deletion", () =>
    Effect.gen(function* () {
      const pullRequests = yield* ProjectionThreadPullRequestRepository;
      const threadId = ThreadId.make("azure-alias-link");
      const row: ProjectionThreadPullRequest = {
        threadId,
        host: "org.visualstudio.com",
        repository: "project/_git/web",
        number: 7,
        url: "https://org.visualstudio.com/project/_git/web/pullrequest/7",
        source: "manual",
        linkedAt: "2026-09-09T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      yield* pullRequests.upsert(row);
      yield* pullRequests.upsert({
        ...row,
        host: "dev.azure.com",
        repository: "org/project/_git/web",
      });
      const found = yield* pullRequests.listByPullRequest({
        host: "ssh.dev.azure.com",
        repository: "v3/org/project/web",
        number: 7,
      });
      assert.deepStrictEqual(found, [
        { ...row, host: "dev.azure.com", repository: "org/project/_git/web" },
      ]);
      assert.deepStrictEqual(
        yield* pullRequests.listByPullRequest({
          host: "dev.azure.com",
          repository: "other/project/_git/web",
          number: 7,
        }),
        [],
      );
      yield* pullRequests.delete({
        threadId,
        host: "vs-ssh.visualstudio.com",
        repository: "v3/org/project/web",
        number: 7,
      });
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId }), []);
    }),
  );

  it.effect("round-trips pull request links with JSON snapshot and stack columns", () =>
    Effect.gen(function* () {
      const pullRequests = yield* ProjectionThreadPullRequestRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-pr-links");
      const otherThreadId = ThreadId.make("thread-pr-links-other");

      const unsynced: ProjectionThreadPullRequest = {
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "manual",
        linkedAt: "2026-03-24T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const synced: ProjectionThreadPullRequest = {
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "stack",
        linkedAt: "2026-03-23T00:00:00.000Z",
        snapshot: {
          state: "open",
          title: "Add links",
          headBranch: "feat/links",
          baseBranch: "main",
          isDraft: false,
          updatedAt: "2026-03-23T01:00:00.000Z",
          syncedAt: "2026-03-23T02:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "stack-1",
          number: 1,
          url: "https://github.com/pingdotgg/t3code/stack/1",
          base: "main",
          layers: [
            { number: 7, headBranch: "feat/links", state: "open" },
            { number: 42, headBranch: "feat/links-ui", state: "open" },
          ],
        },
      };
      const sharedOnOtherThread: ProjectionThreadPullRequest = {
        ...unsynced,
        threadId: otherThreadId,
        source: "agent",
        linkedAt: "2026-03-25T00:00:00.000Z",
      };

      yield* pullRequests.upsert(unsynced);
      yield* pullRequests.upsert(synced);
      yield* pullRequests.upsert(sharedOnOtherThread);

      const rawRows = yield* sql<{
        readonly number: number;
        readonly snapshotJson: string | null;
        readonly stackJson: string | null;
      }>`
        SELECT number, snapshot_json AS "snapshotJson", stack_json AS "stackJson"
        FROM projection_thread_pull_requests
        WHERE thread_id = ${threadId}
        ORDER BY number ASC
      `;
      assert.strictEqual(rawRows[0]?.number, 7);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(rawRows[0]?.snapshotJson ?? "null"), synced.snapshot);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(rawRows[0]?.stackJson ?? "null"), synced.stack);
      assert.strictEqual(rawRows[1]?.snapshotJson, null);
      assert.strictEqual(rawRows[1]?.stackJson, null);

      // Ordered by linked_at, then number.
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId }), [synced, unsynced]);

      // One pull request across threads, ordered by linked_at.
      assert.deepStrictEqual(
        yield* pullRequests.listByPullRequest({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 42,
        }),
        [unsynced, sharedOnOtherThread],
      );

      // Upsert on the composite key replaces snapshot and stack in place.
      const resynced = { ...unsynced, snapshot: synced.snapshot, stack: null } as const;
      yield* pullRequests.upsert(resynced);
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId }), [synced, resynced]);

      yield* pullRequests.delete({
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
      });
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId }), [resynced]);

      yield* pullRequests.deleteByThreadIdAndSource({ threadId, source: "manual" });
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId }), []);
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId: otherThreadId }), [
        sharedOnOtherThread,
      ]);

      yield* pullRequests.deleteByThreadId({ threadId: otherThreadId });
      assert.deepStrictEqual(yield* pullRequests.listByThreadId({ threadId: otherThreadId }), []);
    }),
  );
});
