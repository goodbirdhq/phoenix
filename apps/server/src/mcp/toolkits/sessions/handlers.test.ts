import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GitCommandError,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderInstanceId,
  READ_REPORT_MAX_CHARS,
  ReadReportInput,
  SESSION_REPORT_INLINE_MAX_CHARS,
  SessionOrchestrationDeniedError,
  type SessionReport,
  type SessionUsageSnapshot,
  ThreadId,
  toSessionReportEnvelope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { ProjectionThreadReportRepository } from "../../../persistence/Services/ProjectionThreadReports.ts";
import { ProviderSessionDirectoryPersistenceError } from "../../../provider/Errors.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { layerTest as serverSettingsLayerTest } from "../../../serverSettings.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  assessWorktreeCleanupRisk,
  buildPingSessionSnapshot,
  canReadThreadReports,
  decideBranchCleanup,
  isSessionAlive,
  isSessionBusy,
  make,
  REPORT_NOT_ACCESSIBLE_MESSAGE,
  resolveSendToSessionDelivery,
  resolveSessionCheckout,
  sliceReportBody,
  validateSpawnCheckoutInput,
} from "./handlers.ts";

const gitError = (detail: string) =>
  new GitCommandError({ operation: "test", command: "git", cwd: "/repo", detail });

describe("validateSpawnCheckoutInput", () => {
  it("accepts independent checkout specifications in git repositories", () => {
    expect(validateSpawnCheckoutInput({ gitRef: "feature/review" }, true)).toBeNull();
    expect(
      validateSpawnCheckoutInput({ checkoutPr: 42, branchName: "review/42" }, true),
    ).toBeNull();
    expect(validateSpawnCheckoutInput({ baseRef: "main" }, true)).toBeNull();
  });

  it("rejects a pull request and git ref together", () => {
    expect(validateSpawnCheckoutInput({ checkoutPr: 42, gitRef: "main" }, true)).toBe(
      "checkoutPr cannot be combined with gitRef; choose either a pull request or a git ref.",
    );
  });

  it("requires worktree isolation for checkout fields", () => {
    expect(validateSpawnCheckoutInput({ gitRef: "main", isolation: "project-root" }, true)).toBe(
      'gitRef, baseRef, branchName, and checkoutPr require isolation: "worktree".',
    );
  });

  it("turns the default non-repository fallback into an error for checkout fields", () => {
    expect(validateSpawnCheckoutInput({}, false)).toBeNull();
    expect(validateSpawnCheckoutInput({ baseRef: "main" }, false)).toBe(
      "A git checkout was requested, but this project is not a git repository with a current branch.",
    );
  });
});

describe("resolveSessionCheckout", () => {
  it.effect("returns null when optional checkout metadata cannot be read", () =>
    Effect.gen(function* () {
      const checkout = yield* resolveSessionCheckout(
        {
          localStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "review",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          resolveCommit: () => Effect.fail(gitError("worktree no longer exists")),
        },
        "/missing-worktree",
      );

      expect(checkout).toBeNull();
    }),
  );
});
describe("send_to_session delivery acknowledgement", () => {
  it.effect("maps persisted acknowledgement branches to delivery status", () =>
    Effect.gen(function* () {
      expect(yield* resolveSendToSessionDelivery("thread.turn-start-queued")).toBe("queued");
      expect(yield* resolveSendToSessionDelivery("thread.turn-start-requested")).toBe("immediate");
    }),
  );

  it.effect("reports unknown when acknowledgement readback is missing or unexpected", () =>
    Effect.gen(function* () {
      expect(yield* resolveSendToSessionDelivery(undefined)).toBe("unknown");
      expect(yield* resolveSendToSessionDelivery("thread.message-sent")).toBe("unknown");
    }),
  );
});

const status = (overrides: {
  files?: ReadonlyArray<string>;
  hasUpstream?: boolean;
  aheadCount?: number;
  aheadOfDefaultCount?: number | undefined;
}) => ({
  workingTree: {
    files: (overrides.files ?? []).map((path) => ({ path, insertions: 1, deletions: 0 })),
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: overrides.hasUpstream ?? false,
  aheadCount: overrides.aheadCount ?? 0,
  ...(overrides.aheadOfDefaultCount === undefined
    ? {}
    : { aheadOfDefaultCount: overrides.aheadOfDefaultCount }),
});

describe("isSessionBusy", () => {
  it("treats a starting or running session as busy", () => {
    expect(isSessionBusy("starting")).toBe(true);
    expect(isSessionBusy("running")).toBe(true);
  });

  it("treats every settled-eligible session state as idle", () => {
    expect(isSessionBusy("ready")).toBe(false);
    expect(isSessionBusy("idle")).toBe(false);
    expect(isSessionBusy("stopped")).toBe(false);
    expect(isSessionBusy("interrupted")).toBe(false);
    expect(isSessionBusy("error")).toBe(false);
    expect(isSessionBusy(null)).toBe(false);
    expect(isSessionBusy(undefined)).toBe(false);
  });
});

describe("isSessionAlive", () => {
  it("counts an idle-but-resumable session as alive", () => {
    // The distinction that matters for settle_session: "ready" is not busy,
    // but it still holds a provider process that settling must reclaim.
    expect(isSessionBusy("ready")).toBe(false);
    expect(isSessionAlive("ready")).toBe(true);
    expect(isSessionAlive("idle")).toBe(true);
    expect(isSessionAlive("interrupted")).toBe(true);
    expect(isSessionAlive("error")).toBe(true);
  });

  it("counts a stopped or absent session as already gone", () => {
    expect(isSessionAlive("stopped")).toBe(false);
    expect(isSessionAlive(null)).toBe(false);
    expect(isSessionAlive(undefined)).toBe(false);
  });
});

describe("assessWorktreeCleanupRisk", () => {
  it("clears a worktree whose work is committed and pushed", () => {
    expect(
      assessWorktreeCleanupRisk(
        status({ hasUpstream: true, aheadCount: 0, aheadOfDefaultCount: 4 }),
      ),
    ).toEqual({
      dirtyFiles: [],
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      hasUpstream: true,
      hasUnsavedWork: false,
    });
  });

  it("flags uncommitted files", () => {
    const risk = assessWorktreeCleanupRisk(
      status({ files: ["src/a.ts", "src/b.ts"], hasUpstream: true }),
    );
    expect(risk.hasUnsavedWork).toBe(true);
    expect(risk.dirtyFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(risk.dirtyFileCount).toBe(2);
  });

  it("counts commits ahead of the upstream as unpushed", () => {
    const risk = assessWorktreeCleanupRisk(
      status({ hasUpstream: true, aheadCount: 2, aheadOfDefaultCount: 9 }),
    );
    expect(risk.unpushedCommitCount).toBe(2);
    expect(risk.hasUnsavedWork).toBe(true);
  });

  it("falls back to commits ahead of the default branch when there is no upstream", () => {
    const risk = assessWorktreeCleanupRisk(
      status({ hasUpstream: false, aheadCount: 0, aheadOfDefaultCount: 3 }),
    );
    expect(risk.unpushedCommitCount).toBe(3);
    expect(risk.hasUnsavedWork).toBe(true);
  });

  it("caps the reported file list but keeps the true count", () => {
    const files = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
    const risk = assessWorktreeCleanupRisk(status({ files, hasUpstream: true }));
    expect(risk.dirtyFiles).toHaveLength(20);
    expect(risk.dirtyFileCount).toBe(25);
  });
});

describe("decideBranchCleanup", () => {
  it("deletes a Phoenix temporary worktree branch", () => {
    expect(decideBranchCleanup("t3code/1a2b3c4d")).toEqual({ deleteBranch: true, detail: null });
  });

  it("keeps a branch Phoenix did not create, and says so", () => {
    const decision = decideBranchCleanup("feature/user-work");
    expect(decision.deleteBranch).toBe(false);
    expect(decision.detail).toContain("feature/user-work");
  });

  it("has nothing to do when the thread has no branch", () => {
    expect(decideBranchCleanup(null)).toEqual({ deleteBranch: false, detail: null });
  });
});

const makeReport = (overrides: Partial<SessionReport> = {}): SessionReport => ({
  reportId: "report-1",
  threadId: ThreadId.make("child-thread"),
  status: "success",
  title: "Did the work",
  summary: "All done.",
  artifacts: [],
  origin: "agent",
  createdAt: "2026-08-12T00:00:00.000Z",
  ...overrides,
});

describe("canReadThreadReports", () => {
  const parent = "parent-thread";
  const caller = "caller-thread";

  it("allows reading a spawned child's reports", () => {
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: null,
        targetThreadId: "child-thread",
        targetSpawnedByThreadId: caller,
      }),
    ).toBe(true);
  });

  it("allows reading a sibling's reports (same spawning parent)", () => {
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: parent,
        targetThreadId: "sibling-thread",
        targetSpawnedByThreadId: parent,
      }),
    ).toBe(true);
  });

  it("allows a session to read its own reports", () => {
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: parent,
        targetThreadId: caller,
        targetSpawnedByThreadId: parent,
      }),
    ).toBe(true);
  });

  it("denies unrelated threads", () => {
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: parent,
        targetThreadId: "stranger-thread",
        targetSpawnedByThreadId: "other-parent",
      }),
    ).toBe(false);
  });

  it("denies the caller's own parent", () => {
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: parent,
        targetThreadId: parent,
        targetSpawnedByThreadId: null,
      }),
    ).toBe(false);
  });

  it("never treats two top-level threads as siblings", () => {
    // Both have no parent; a shared `null` must not read as "same parent".
    expect(
      canReadThreadReports({
        callerThreadId: caller,
        callerSpawnedByThreadId: null,
        targetThreadId: "other-top-level",
        targetSpawnedByThreadId: null,
      }),
    ).toBe(false);
  });
});

describe("sliceReportBody", () => {
  it("returns the whole summary when it fits one page", () => {
    expect(sliceReportBody("short report", {})).toEqual({
      body: "short report",
      offset: 0,
      totalChars: 12,
      hasMore: false,
    });
  });

  it("pages through a long summary with offset and maxChars", () => {
    const summary = "abcdefghij";
    expect(sliceReportBody(summary, { maxChars: 4 })).toEqual({
      body: "abcd",
      offset: 0,
      totalChars: 10,
      hasMore: true,
    });
    expect(sliceReportBody(summary, { offset: 4, maxChars: 4 })).toEqual({
      body: "efgh",
      offset: 4,
      totalChars: 10,
      hasMore: true,
    });
    expect(sliceReportBody(summary, { offset: 8, maxChars: 4 })).toEqual({
      body: "ij",
      offset: 8,
      totalChars: 10,
      hasMore: false,
    });
  });

  it("clamps offsets past the end to an empty final page", () => {
    expect(sliceReportBody("abc", { offset: 99 })).toEqual({
      body: "",
      offset: 3,
      totalChars: 3,
      hasMore: false,
    });
  });

  it("defaults to the maximum page size", () => {
    const summary = "x".repeat(READ_REPORT_MAX_CHARS + 10);
    const page = sliceReportBody(summary, {});
    expect(page.body.length).toBe(READ_REPORT_MAX_CHARS);
    expect(page.hasMore).toBe(true);
  });
});

describe("toSessionReportEnvelope", () => {
  it("carries the whole summary for small reports", () => {
    const report = makeReport();
    const envelope = toSessionReportEnvelope(report);
    expect(envelope.abstract).toBe(report.summary);
    expect(envelope.truncated).toBe(false);
    expect(envelope.summaryChars).toBe(report.summary.length);
    expect(envelope.reportId).toBe(report.reportId);
    expect(envelope.threadId).toBe(report.threadId);
  });

  it("prefers the author abstract for large reports", () => {
    const report = makeReport({
      summary: "y".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1),
      abstract: "The short version.",
    });
    const envelope = toSessionReportEnvelope(report);
    expect(envelope.abstract).toBe("The short version.");
    expect(envelope.truncated).toBe(true);
    expect(envelope.summaryChars).toBe(SESSION_REPORT_INLINE_MAX_CHARS + 1);
  });

  it("falls back to a truncated summary head when no abstract was posted", () => {
    const report = makeReport({ summary: "z".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 1) });
    const envelope = toSessionReportEnvelope(report);
    expect(envelope.truncated).toBe(true);
    expect(envelope.abstract.length).toBeLessThanOrEqual(500);
    expect(envelope.abstract.endsWith("…")).toBe(true);
  });
});

describe("toSessionReportEnvelope fallback abstract markdown safety", () => {
  const bigSummaryWithFenceAt = (fenceStart: number): string => {
    const prefix = "p".repeat(fenceStart);
    return `${prefix}\n\`\`\`ts\nconst x = 1;\n${"c".repeat(SESSION_REPORT_INLINE_MAX_CHARS)}\n\`\`\``;
  };

  it("drops an unterminated code fence instead of cutting inside it", () => {
    const report = makeReport({ summary: bigSummaryWithFenceAt(450) });
    const envelope = toSessionReportEnvelope(report);
    expect(envelope.truncated).toBe(true);
    const fenceCount = envelope.abstract.split("```").length - 1;
    expect(fenceCount % 2).toBe(0);
    expect(envelope.abstract).not.toContain("const x = 1;");
  });

  it("closes the fence when the summary starts inside one", () => {
    const summary = `\`\`\`\n${"c".repeat(SESSION_REPORT_INLINE_MAX_CHARS + 10)}\n\`\`\``;
    const envelope = toSessionReportEnvelope(makeReport({ summary }));
    const fenceCount = envelope.abstract.split("```").length - 1;
    expect(fenceCount % 2).toBe(0);
    expect(envelope.abstract.startsWith("```")).toBe(true);
  });

  it("never ends the fallback abstract on half a surrogate pair", () => {
    const summary = "😀".repeat(SESSION_REPORT_INLINE_MAX_CHARS);
    const envelope = toSessionReportEnvelope(makeReport({ summary }));
    const beforeEllipsis = envelope.abstract.charCodeAt(envelope.abstract.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });
});

describe("sliceReportBody surrogate safety", () => {
  it("never splits a surrogate pair at a page boundary and loses no characters", () => {
    const summary = `abc${"😀".repeat(5)}xyz`;
    let offset = 0;
    let rebuilt = "";
    for (let i = 0; i < 32; i += 1) {
      const page = sliceReportBody(summary, { offset, maxChars: 3 });
      const codes = [...page.body].map((ch) => ch.codePointAt(0) ?? 0);
      expect(codes.every((code) => code < 0xd800 || code > 0xdfff)).toBe(true);
      rebuilt += page.body;
      if (!page.hasMore) {
        break;
      }
      offset = page.offset + page.body.length;
    }
    expect(rebuilt).toBe(summary);
  });

  it("backs an arbitrary offset off a low surrogate to include the whole character", () => {
    const summary = "a😀b";
    const page = sliceReportBody(summary, { offset: 2, maxChars: 10 });
    expect(page.offset).toBe(1);
    expect(page.body).toBe("😀b");
  });

  it("extends a one-unit page so a surrogate pair still makes progress", () => {
    const summary = "😀😀";
    const page = sliceReportBody(summary, { offset: 0, maxChars: 1 });
    expect(page.body).toBe("😀");
    expect(page.hasMore).toBe(true);
  });
});

describe("read_report input decoding", () => {
  const decode = Schema.decodeUnknownSync(ReadReportInput);

  it("accepts reportId, threadId, and pagination in range", () => {
    expect(
      decode({ reportId: "report-1", threadId: "thread-1", offset: 0, maxChars: 16_384 }),
    ).toEqual({ reportId: "report-1", threadId: "thread-1", offset: 0, maxChars: 16_384 });
  });

  it("rejects out-of-range page sizes and negative offsets", () => {
    expect(() => decode({ reportId: "report-1", maxChars: 0 })).toThrow();
    expect(() => decode({ reportId: "report-1", maxChars: -1 })).toThrow();
    expect(() => decode({ reportId: "report-1", maxChars: 16_385 })).toThrow();
    expect(() => decode({ reportId: "report-1", offset: -1 })).toThrow();
  });
});

describe("read_report denial shape", () => {
  it("uses one constant, id-free message for every unreadable case", () => {
    // The handler has a single denial construction site fed by this constant;
    // anything interpolated here would leak which ids exist.
    expect(REPORT_NOT_ACCESSIBLE_MESSAGE).not.toMatch(/report-|thread-|\$\{/);
    expect(REPORT_NOT_ACCESSIBLE_MESSAGE.length).toBeGreaterThan(0);
  });
});

const pingThreadId = "thread-1" as ThreadId;
const pingProjectId = "project-1" as ProjectId;
const now = "2026-08-12T00:00:00.000Z";

const baseShell = {
  id: pingThreadId,
  projectId: pingProjectId,
  title: "Fix the flaky test",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: {
    threadId: pingThreadId,
    status: "running",
    providerName: "Claude Agent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} satisfies OrchestrationThreadShell;

const zeroUsage = { elapsedMs: 0 } satisfies SessionUsageSnapshot;

describe("buildPingSessionSnapshot", () => {
  it("reports idle status with no activity when nothing else is known", () => {
    expect(
      buildPingSessionSnapshot({
        shell: baseShell,
        lastActivityAt: null,
        hasReport: false,
        lastAssistantMessage: null,
        usage: zeroUsage,
      }),
    ).toEqual({
      sessionStatus: "running",
      settled: false,
      lastActivityAt: null,
      currentActivity: null,
      planProgress: null,
      hasReport: false,
      lastAssistantMessage: null,
      usage: zeroUsage,
    });
  });

  it("surfaces background liveness, plan progress, and activity timestamp from the shell", () => {
    const shell = {
      ...baseShell,
      settledAt: now,
      backgroundLiveness: "working",
      planProgress: { step: "Run the test suite", completedSteps: 2, totalSteps: 5 },
    } satisfies OrchestrationThreadShell;

    const result = buildPingSessionSnapshot({
      shell,
      lastActivityAt: "2026-08-12T00:05:00.000Z",
      hasReport: false,
      lastAssistantMessage: null,
      usage: zeroUsage,
    });

    expect(result.settled).toBe(true);
    expect(result.currentActivity).toBe("working");
    expect(result.planProgress).toEqual({
      step: "Run the test suite",
      completedSteps: 2,
      totalSteps: 5,
    });
    expect(result.lastActivityAt).toBe("2026-08-12T00:05:00.000Z");
  });

  it("passes hasReport through as given and truncates a long last assistant message", () => {
    const result = buildPingSessionSnapshot({
      shell: baseShell,
      lastActivityAt: null,
      hasReport: true,
      lastAssistantMessage: "a".repeat(600),
      usage: zeroUsage,
    });

    expect(result.hasReport).toBe(true);
    expect(result.lastAssistantMessage).toHaveLength(500);
    expect(result.lastAssistantMessage?.endsWith("…")).toBe(true);
  });

  it("returns a last assistant message that fits unchanged", () => {
    const result = buildPingSessionSnapshot({
      shell: baseShell,
      lastActivityAt: null,
      hasReport: false,
      lastAssistantMessage: "on it",
      usage: zeroUsage,
    });

    expect(result.lastAssistantMessage).toBe("on it");
  });

  it("passes the resolved usage snapshot through unchanged", () => {
    const usage = {
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      turnCount: 3,
      elapsedMs: 45_000,
      lastTurnDurationMs: 12_000,
    } satisfies SessionUsageSnapshot;

    const result = buildPingSessionSnapshot({
      shell: baseShell,
      lastActivityAt: null,
      hasReport: false,
      lastAssistantMessage: null,
      usage,
    });

    expect(result.usage).toEqual(usage);
  });
});

const parentThreadId = "parent-1" as ThreadId;
const childThreadId = "child-1" as ThreadId;

const childShell = {
  ...baseShell,
  id: childThreadId,
  spawnedByThreadId: parentThreadId,
} satisfies OrchestrationThreadShell;

const invocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: parentThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["sessions"] as const),
  issuedAt: 1,
} satisfies McpInvocationContext.McpInvocationScope;

// Every handler-level test builds the toolkit's `make` against mocked
// services, then runs one handler call with the capability scope provided
// the way the MCP dispatch path provides it per call. engine.dispatch and
// startup.enqueueCommand both die if called, so a passing test also proves
// the tool never dispatches a command or starts a turn.
const runHandler = <A, E, R>(
  run: (handlers: Effect.Success<typeof make>) => Effect.Effect<A, E, R>,
  overrides: {
    getThreadShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadShellById"];
    getThreadHasReport?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadHasReport"];
    getLastAssistantMessage?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getLastAssistantMessage"];
    getLatestUsageActivity?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getLatestUsageActivity"];
    getThreadTurnCount?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadTurnCount"];
    listBindings?: ProviderSessionDirectory["Service"]["listBindings"];
  } = {},
) =>
  Effect.gen(function* () {
    const handlers = yield* make;
    return yield* run(handlers);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocationScope),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        serverSettingsLayerTest({ enableSessionOrchestration: true }),
        Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die("engine.dispatch must not be called by a read-only tool"),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
        Layer.mock(ThreadTurnBootstrap.ThreadTurnBootstrap)({}),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById:
            overrides.getThreadShellById ??
            ((id) =>
              Effect.succeed(id === childThreadId ? Option.some(childShell) : Option.none())),
          getThreadHasReport: overrides.getThreadHasReport ?? (() => Effect.succeed(false)),
          getLastAssistantMessage:
            overrides.getLastAssistantMessage ?? (() => Effect.succeed(Option.none())),
          getLatestUsageActivity:
            overrides.getLatestUsageActivity ?? (() => Effect.succeed(Option.none())),
          getThreadTurnCount: overrides.getThreadTurnCount ?? (() => Effect.succeed(0)),
          // read_session's pre-existing report/messages fetch; not under test
          // here, so a fixed empty response is enough to keep it from dying.
          getThreadDetailById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderSessionDirectory)({
          listBindings: overrides.listBindings ?? (() => Effect.succeed([])),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        // Not exercised by ping_session/read_session (only read_report/post_report
        // touch it); unused methods die if called.
        Layer.mock(ProjectionThreadReportRepository)({}),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand: () =>
            Effect.die("startup.enqueueCommand must not be called by a read-only tool"),
        }),
      ),
    ),
  );

describe("ping_session (handler)", () => {
  it.effect("denies a thread this session did not spawn", () =>
    Effect.gen(function* () {
      const strangerThreadId = "stranger-1" as ThreadId;
      const error = yield* runHandler(
        (handlers) => handlers.ping_session({ threadId: strangerThreadId }),
        {
          getThreadShellById: (id) =>
            Effect.succeed(
              id === strangerThreadId
                ? Option.some({ ...childShell, id: strangerThreadId, spawnedByThreadId: null })
                : Option.none(),
            ),
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationDeniedError);
      expect(error).toMatchObject({ reason: "not_spawned_by_this_session" });
    }),
  );

  it.effect(
    "degrades to nulls, and still succeeds, when directory/report/message enrichment fails",
    () =>
      Effect.gen(function* () {
        const result = yield* runHandler(
          (handlers) => handlers.ping_session({ threadId: childThreadId }),
          {
            getThreadHasReport: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test",
                  detail: "projection unavailable",
                }),
              ),
            getLastAssistantMessage: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test",
                  detail: "projection unavailable",
                }),
              ),
            listBindings: () =>
              Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "test",
                  detail: "directory unavailable",
                }),
              ),
            getLatestUsageActivity: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test",
                  detail: "projection unavailable",
                }),
              ),
            getThreadTurnCount: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "test",
                  detail: "projection unavailable",
                }),
              ),
          },
        );

        // Shell-derived fields still come through even though every
        // optional enrichment failed.
        expect(result.sessionStatus).toBe("running");
        expect(result.settled).toBe(false);
        // Failed enrichment degrades to nulls/false instead of failing the call.
        expect(result.lastActivityAt).toBeNull();
        expect(result.hasReport).toBe(false);
        expect(result.lastAssistantMessage).toBeNull();
        // Token/turn fields are omitted rather than failing the whole ping;
        // elapsedMs is server-computed and always present regardless.
        expect(result.usage).toEqual({ elapsedMs: expect.any(Number) });
      }),
  );

  it.effect("populates usage from the latest context-window activity and turn count", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.ping_session({ threadId: childThreadId }),
        {
          getLatestUsageActivity: () =>
            Effect.succeed(
              Option.some({ inputTokens: 1000, outputTokens: 250, totalProcessedTokens: 4000 }),
            ),
          getThreadTurnCount: () => Effect.succeed(3),
        },
      );

      expect(result.usage?.inputTokens).toBe(1000);
      expect(result.usage?.outputTokens).toBe(250);
      // Prefers the cumulative totalProcessedTokens over the context-fill
      // usedTokens when the provider reports both.
      expect(result.usage?.totalTokens).toBe(4000);
      expect(result.usage?.turnCount).toBe(3);
      expect(result.usage?.elapsedMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("never dispatches a command or starts a turn", () =>
    Effect.gen(function* () {
      // engine.dispatch and startup.enqueueCommand both die if called (see
      // runHandler); reaching a result at all proves ping_session never took
      // either path.
      const result = yield* runHandler((handlers) =>
        handlers.ping_session({ threadId: childThreadId }),
      );
      expect(result.threadId).toBe(childThreadId);
    }),
  );

  it.effect(
    "returns the last assistant message independent of turn boundaries, even when the newest turn is user-only",
    () =>
      Effect.gen(function* () {
        // getLastAssistantMessage is a purpose-built query with no notion of
        // "the current turn" — unlike a turn-windowed detail read, it cannot
        // miss an earlier assistant message just because the newest turn
        // happens to hold only a user message.
        const result = yield* runHandler(
          (handlers) => handlers.ping_session({ threadId: childThreadId }),
          {
            getThreadHasReport: () => Effect.succeed(true),
            getLastAssistantMessage: () =>
              Effect.succeed(Option.some({ text: "Finished the refactor.", createdAt: now })),
          },
        );

        expect(result.hasReport).toBe(true);
        expect(result.lastAssistantMessage).toBe("Finished the refactor.");
      }),
  );
});

describe("read_session (handler)", () => {
  it.effect("degrades lastActivityAt to null when the provider session directory fails", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.read_session({ threadId: childThreadId }),
        {
          listBindings: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "test",
                detail: "directory unavailable",
              }),
            ),
        },
      );

      expect(result.sessionStatus).toBe("running");
      expect(result.lastActivityAt).toBeNull();
    }),
  );
});
