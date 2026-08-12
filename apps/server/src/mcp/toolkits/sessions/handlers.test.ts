import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GitCommandError,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderInstanceId,
  READ_REPORT_MAX_CHARS,
  ReadReportInput,
  SESSION_REPORT_INLINE_MAX_CHARS,
  SessionOrchestrationDeniedError,
  SessionOrchestrationInvalidInputError,
  SessionOrchestrationReportAlreadySupersededError,
  type SessionReport,
  type SessionUsageSnapshot,
  supersededReportNotice,
  ThreadId,
  toSessionReportEnvelope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitRepositoryLock from "../../../git/GitRepositoryLock.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import {
  type ProjectionThreadReport,
  ProjectionThreadReportRepository,
  type ProjectionThreadReportRepositoryShape,
} from "../../../persistence/Services/ProjectionThreadReports.ts";
import { ProviderSessionDirectoryPersistenceError } from "../../../provider/Errors.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { layerTest as serverSettingsLayerTest } from "../../../serverSettings.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  assessGitLockStaleness,
  assessWorktreeCleanupRisk,
  buildPingSessionSnapshot,
  canReadThreadReports,
  countsTowardActiveCap,
  decideBranchCleanup,
  parseGitLockPath,
  isSessionAlive,
  isSessionBusy,
  make,
  REPORT_NOT_ACCESSIBLE_MESSAGE,
  resolveSendToSessionDelivery,
  resolveSessionCheckout,
  sliceReportBody,
  SUPERSEDES_REPORT_NOT_FOUND_MESSAGE,
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
  });

  it("counts a stopped, errored, or absent session as already gone", () => {
    // "error" is terminal, same as "stopped": the reactor synthesizes a
    // report for either (see "Terminal reports"), so a crashed session has
    // no live process left to reclaim and must not squat on a spawn slot.
    expect(isSessionAlive("stopped")).toBe(false);
    expect(isSessionAlive("error")).toBe(false);
    expect(isSessionAlive(null)).toBe(false);
    expect(isSessionAlive(undefined)).toBe(false);
  });
});

describe("countsTowardActiveCap", () => {
  // countsTowardActiveCap takes a resolved hasLiveBinding lookup, not a
  // session status: status alone is not proof of anything (see
  // resolveHasLiveBinding's doc — Codex/OpenCode retain an errored
  // binding), so the predicate is exercised directly against binding
  // presence/absence, independent of any particular status string.
  const alwaysBound = () => true;
  const neverBound = () => false;
  const withThread = (settledAt: string | null) =>
    ({ id: childThreadId, settledAt }) as unknown as OrchestrationThreadShell;

  it("counts an unsettled child regardless of binding state", () => {
    expect(countsTowardActiveCap(withThread(null), neverBound)).toBe(true);
    expect(countsTowardActiveCap(withThread(null), alwaysBound)).toBe(true);
  });

  it("still counts a settled child that still has a live binding", () => {
    expect(countsTowardActiveCap(withThread(now), alwaysBound)).toBe(true);
  });

  it("does not count a settled child with no live binding", () => {
    expect(countsTowardActiveCap(withThread(now), neverBound)).toBe(false);
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
    expect(decideBranchCleanup("t3code/1a2b3c4d")).toEqual({
      deleteBranch: true,
      requiresMergeProof: false,
      detail: null,
    });
  });

  it("keeps a branch Phoenix did not create, and says so", () => {
    const decision = decideBranchCleanup("feature/user-work");
    expect(decision.deleteBranch).toBe(false);
    expect(decision.detail).toContain("feature/user-work");
    expect(decision.detail).toContain("cleanupBranch");
  });

  it("deletes a user branch only against a merge proof when cleanupBranch is asked for", () => {
    expect(decideBranchCleanup("feature/user-work", { cleanupBranch: true })).toEqual({
      deleteBranch: true,
      requiresMergeProof: true,
      detail: null,
    });
    // Phoenix's own throwaway branches never need the proof: nothing but this
    // worktree ever pointed at them.
    expect(decideBranchCleanup("t3code/1a2b3c4d", { cleanupBranch: true }).requiresMergeProof).toBe(
      false,
    );
  });

  it("has nothing to do when the thread has no branch", () => {
    expect(decideBranchCleanup(null)).toEqual({
      deleteBranch: false,
      requiresMergeProof: false,
      detail: null,
    });
  });
});

describe("parseGitLockPath", () => {
  it("finds the lock path in git's index-lock failure", () => {
    expect(parseGitLockPath("fatal: Unable to create '/repo/.git/index.lock': File exists.")).toBe(
      "/repo/.git/index.lock",
    );
  });

  it("finds the lock path in a ref-lock failure", () => {
    expect(
      parseGitLockPath(
        "error: cannot lock ref 'refs/heads/x': Unable to create '/repo/.git/refs/heads/x.lock': File exists",
      ),
    ).toBe("/repo/.git/refs/heads/x.lock");
  });

  it("leaves ordinary git failures alone", () => {
    expect(parseGitLockPath("fatal: '/tmp/wt' is not a working tree")).toBeNull();
    // "Unable to create" without the lock file is a different failure.
    expect(parseGitLockPath("fatal: Unable to create directory '/tmp/wt'")).toBeNull();
  });
});

describe("assessGitLockStaleness", () => {
  it("calls an empty, long-untouched lock stale", () => {
    const assessment = assessGitLockStaleness({ sizeBytes: 0, ageMs: 10 * 60_000 });
    expect(assessment.appearsStale).toBe(true);
    expect(assessment.detail).toContain("died mid-write");
  });

  it("refuses to call a fresh lock stale, however empty", () => {
    // Inside the window a git process is plausibly still writing, and the
    // whole point of the heuristic is to never accuse a live one.
    expect(assessGitLockStaleness({ sizeBytes: 0, ageMs: 5_000 }).appearsStale).toBe(false);
  });

  it("refuses to call a lock with contents stale", () => {
    expect(assessGitLockStaleness({ sizeBytes: 96, ageMs: 10 * 60_000 }).appearsStale).toBe(false);
  });

  it("says nothing definite when the lock could not be inspected", () => {
    const assessment = assessGitLockStaleness({ sizeBytes: null, ageMs: null });
    expect(assessment.appearsStale).toBe(false);
    expect(assessment.detail).toContain("could not be inspected");
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

  it("carries both ends of an amendment chain so a parent can follow it", () => {
    const superseded = toSessionReportEnvelope(
      makeReport({ reportId: "report-original", supersededByReportId: "report-amendment" }),
    );
    expect(superseded.supersededByReportId).toBe("report-amendment");
    expect(superseded.supersedesReportId).toBeUndefined();

    const amendment = toSessionReportEnvelope(
      makeReport({ reportId: "report-amendment", supersedesReportId: "report-original" }),
    );
    expect(amendment.supersedesReportId).toBe("report-original");
    expect(amendment.supersededByReportId).toBeUndefined();
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
      lastTurnInputTokens: 1200,
      lastTurnOutputTokens: 340,
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

// The calling session itself. post_report and read_report both resolve the
// caller's own shell before doing anything, so the default lookup has to know
// about it as well as the child.
const parentShell = {
  ...baseShell,
  id: parentThreadId,
} satisfies OrchestrationThreadShell;

// Shared session-status fixtures: childShell inherits baseShell's "running"
// (alive) session by default, which is wrong for anything meant to
// represent a settled-and-actually-dead child — those must override with
// stoppedSession explicitly, or they silently count as active/alive.
const stoppedSession = { ...childShell.session, status: "stopped" as const };
const errorSession = { ...childShell.session, status: "error" as const };
const aliveSession = { ...childShell.session, status: "ready" as const };

// Stubs a listBindings response reporting a live binding for exactly the
// given threadIds — the source countsTowardActiveCap/stopChildSession
// consult, independent of session status (round-3 review: status alone is
// not proof of anything, Codex/OpenCode retain errored bindings).
const bindingsFor =
  (ids: ReadonlyArray<ThreadId>): ProviderSessionDirectory["Service"]["listBindings"] =>
  () =>
    Effect.succeed(
      ids.map((threadId) => ({
        threadId,
        provider: "codex" as const,
        lastSeenAt: now,
      })),
    ) as unknown as ReturnType<ProviderSessionDirectory["Service"]["listBindings"]>;

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
    getShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getShellSnapshot"];
    getArchivedShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getArchivedShellSnapshot"];
    getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
    listBindings?: ProviderSessionDirectory["Service"]["listBindings"];
    findByReportId?: ProjectionThreadReportRepositoryShape["findByReportId"];
    listByThreadId?: ProjectionThreadReportRepositoryShape["listByThreadId"];
    // Supplied together by the write-path tests (post_report): the default
    // pair dies on use, which is what proves the read-only tools never
    // dispatch.
    dispatch?: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
    enqueueCommand?: ServerRuntimeStartup.ServerRuntimeStartup["Service"]["enqueueCommand"];
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
          dispatch:
            overrides.dispatch ??
            (() => Effect.die("engine.dispatch must not be called by a read-only tool")),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
        Layer.mock(ThreadTurnBootstrap.ThreadTurnBootstrap)({}),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById:
            overrides.getThreadShellById ??
            ((id) =>
              Effect.succeed(
                id === childThreadId
                  ? Option.some(childShell)
                  : id === parentThreadId
                    ? Option.some(parentShell)
                    : Option.none(),
              )),
          getThreadHasReport: overrides.getThreadHasReport ?? (() => Effect.succeed(false)),
          getLastAssistantMessage:
            overrides.getLastAssistantMessage ?? (() => Effect.succeed(Option.none())),
          getLatestUsageActivity:
            overrides.getLatestUsageActivity ?? (() => Effect.succeed(Option.none())),
          getThreadTurnCount: overrides.getThreadTurnCount ?? (() => Effect.succeed(0)),
          // read_session's pre-existing report/messages fetch; not under test
          // here, so a fixed empty response is enough to keep it from dying.
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getShellSnapshot:
            overrides.getShellSnapshot ??
            (() =>
              Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: now })),
          getArchivedShellSnapshot:
            overrides.getArchivedShellSnapshot ??
            (() =>
              Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: now })),
          getProjectShellById:
            overrides.getProjectShellById ?? (() => Effect.succeed(Option.none())),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderSessionDirectory)({
          listBindings: overrides.listBindings ?? (() => Effect.succeed([])),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        // Only settle_session's cleanup path touches these two; a read-only
        // tool that reaches them is a bug, so the mocks stay empty.
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({}),
        GitRepositoryLock.layer.pipe(Layer.provide(NodeServices.layer)),
        // Not exercised by ping_session/read_session (only read_report/post_report
        // touch it); unused methods die if called.
        Layer.mock(ProjectionThreadReportRepository)({
          ...(overrides.findByReportId ? { findByReportId: overrides.findByReportId } : {}),
          ...(overrides.listByThreadId ? { listByThreadId: overrides.listByThreadId } : {}),
        }),
        Layer.mock(ProjectionTurnRepository)({
          listQueuedDeliveryReceipts: () => Effect.succeed([]),
        }),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand:
            overrides.enqueueCommand ??
            (() => Effect.die("startup.enqueueCommand must not be called by a read-only tool")),
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

      expect(result.usage?.lastTurnInputTokens).toBe(1000);
      expect(result.usage?.lastTurnOutputTokens).toBe(250);
      // totalTokens comes only from the provider's own cumulative counter.
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

const projectedReport = (
  overrides: Partial<ProjectionThreadReport> & Pick<ProjectionThreadReport, "reportId">,
): ProjectionThreadReport => ({
  // post_report and read_report both run as the calling thread, which in this
  // harness is the parent.
  threadId: parentThreadId,
  status: "success",
  title: "Did the work",
  summary: "All done.",
  abstract: null,
  artifacts: [],
  origin: "agent",
  supersedesReportId: null,
  createdAt: now,
  ...overrides,
});

describe("post_report supersession (handler)", () => {
  // These mocks are annotated against the real service shapes rather than
  // left to inference: an untyped mock widens the handler's error channel to
  // `unknown`, which silently defeats the `Effect.flip` assertions below.
  type WritePathOverrides = {
    readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
    readonly enqueueCommand: ServerRuntimeStartup.ServerRuntimeStartup["Service"]["enqueueCommand"];
  };

  // Captures what post_report dispatched, so the tests can assert the
  // amendment link reached the command rather than only the tool result.
  const capturingDispatch = (captured: Array<OrchestrationCommand>): WritePathOverrides => ({
    dispatch: (command) =>
      Effect.sync(() => {
        captured.push(command);
        return { sequence: 1 };
      }),
    enqueueCommand: (effect) => effect,
  });

  // The decider's actual refusal, so the race tests fail the way the real
  // dispatch path fails rather than with a stand-in Error.
  const decliningDispatch = (
    detail: string,
    onDispatch: () => void = () => {},
  ): WritePathOverrides => ({
    dispatch: () =>
      Effect.sync(onDispatch).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.report.post",
              detail,
            }),
          ),
        ),
      ),
    enqueueCommand: (effect) => effect,
  });

  // Faithful to the real query, which is scoped by thread: a report on
  // another thread is simply not in the result, which is exactly why the
  // cross-thread case cannot be distinguished from an unknown id.
  const threadReports = (
    reports: ReadonlyArray<ProjectionThreadReport>,
  ): Pick<ProjectionThreadReportRepositoryShape, "listByThreadId"> => ({
    listByThreadId: ({ threadId }) =>
      Effect.succeed(reports.filter((entry) => entry.threadId === threadId)),
  });

  it.effect("carries a valid supersedesReportId into the command and the result", () =>
    Effect.gen(function* () {
      const captured: Array<OrchestrationCommand> = [];
      const result = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Amended: also did the late instruction",
            summary: "The queued instruction arrived after the first report; it is done now.",
            supersedesReportId: "report-original",
          }),
        {
          ...capturingDispatch(captured),
          ...threadReports([projectedReport({ reportId: "report-original" })]),
        },
      );

      expect(result.supersedesReportId).toBe("report-original");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: "thread.report.post",
        supersedesReportId: "report-original",
      });
    }),
  );

  it.effect("refuses a supersedesReportId that names no report, without dispatching", () =>
    Effect.gen(function* () {
      const captured: Array<OrchestrationCommand> = [];
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Amended",
            summary: "Amending a report that does not exist.",
            supersedesReportId: "report-nonexistent",
          }),
        {
          ...capturingDispatch(captured),
          ...threadReports([projectedReport({ reportId: "report-original" })]),
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationInvalidInputError);
      expect(error.message).toBe(SUPERSEDES_REPORT_NOT_FOUND_MESSAGE);
      // A dangling amendment link must never reach the event log.
      expect(captured).toHaveLength(0);
    }),
  );

  it.effect("refuses a supersedesReportId belonging to another thread", () =>
    Effect.gen(function* () {
      const captured: Array<OrchestrationCommand> = [];
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Amended",
            summary: "Amending someone else's report.",
            supersedesReportId: "report-of-another-thread",
          }),
        {
          ...capturingDispatch(captured),
          ...threadReports([
            projectedReport({ reportId: "report-of-another-thread", threadId: childThreadId }),
          ]),
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationInvalidInputError);
      // Same message as the unknown-id case: a report is a session's account
      // of its own work, and the denial must not double as a probe for which
      // report ids exist on other threads.
      expect(error.message).toBe(SUPERSEDES_REPORT_NOT_FOUND_MESSAGE);
      expect(captured).toHaveLength(0);
    }),
  );

  it.effect("refuses to fork a chain, naming the report to supersede instead", () =>
    Effect.gen(function* () {
      const captured: Array<OrchestrationCommand> = [];
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Second amendment of the same report",
            summary: "Would fork the chain.",
            supersedesReportId: "report-original",
          }),
        {
          ...capturingDispatch(captured),
          ...threadReports([
            projectedReport({ reportId: "report-original" }),
            projectedReport({
              reportId: "report-amendment",
              supersedesReportId: "report-original",
            }),
          ]),
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationReportAlreadySupersededError);
      expect(error).toMatchObject({
        reportId: "report-original",
        supersededByReportId: "report-amendment",
        chainHeadReportId: "report-amendment",
      });
      expect(captured).toHaveLength(0);
    }),
  );

  it.effect("points a refused fork at the head of a longer chain", () =>
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Amendment of a stale link",
            summary: "Two amendments behind.",
            supersedesReportId: "report-original",
          }),
        {
          ...capturingDispatch([]),
          ...threadReports([
            projectedReport({ reportId: "report-original" }),
            projectedReport({ reportId: "report-second", supersedesReportId: "report-original" }),
            projectedReport({ reportId: "report-third", supersedesReportId: "report-second" }),
          ]),
        },
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        supersededByReportId: "report-second",
        chainHeadReportId: "report-third",
      });
      expect(error.message).toContain("supersede report-third instead");
    }),
  );

  it.effect("turns a lost amendment race into the same actionable error", () =>
    Effect.gen(function* () {
      // The race the decider resolves: this caller's pre-check passed, another
      // amendment took the chain head, and the decider rejected the dispatch.
      // A generic dispatch failure would leave the loser with nowhere to
      // re-attach, so the chain is re-read and reported instead.
      let dispatched = false;
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Lost the race",
            summary: "Superseded concurrently.",
            supersedesReportId: "report-original",
          }),
        {
          ...decliningDispatch(
            "Report report-original is already superseded by report-winner",
            () => {
              dispatched = true;
            },
          ),
          // First read (pre-check) sees an unsuperseded report; the re-read
          // after the rejection sees the winner.
          listByThreadId: () =>
            Effect.succeed(
              dispatched
                ? [
                    projectedReport({ reportId: "report-original" }),
                    projectedReport({
                      reportId: "report-winner",
                      supersedesReportId: "report-original",
                    }),
                  ]
                : [projectedReport({ reportId: "report-original" })],
            ),
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationReportAlreadySupersededError);
      expect(error).toMatchObject({
        reportId: "report-original",
        supersededByReportId: "report-winner",
        chainHeadReportId: "report-winner",
      });
    }),
  );

  it.effect("lets the original dispatch failure stand when the chain did not move", () =>
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Dispatch broke",
            summary: "Unrelated failure.",
            supersedesReportId: "report-original",
          }),
        {
          // A failure that has nothing to do with supersession.
          ...decliningDispatch("Projection write failed while persisting the report."),
          listByThreadId: () => Effect.succeed([projectedReport({ reportId: "report-original" })]),
        },
      ).pipe(Effect.flip);

      // Not relabelled as a supersession problem: it was not one.
      expect(error).not.toBeInstanceOf(SessionOrchestrationReportAlreadySupersededError);
    }),
  );

  it.effect("posts an ordinary report without touching the report repository", () =>
    Effect.gen(function* () {
      const captured: Array<OrchestrationCommand> = [];
      // listByThreadId is left unmocked here, so it dies if called: a report
      // with no supersedesReportId must not pay for a lookup.
      const result = yield* runHandler(
        (handlers) =>
          handlers.post_report({
            status: "success",
            title: "Did the work",
            summary: "All done.",
          }),
        capturingDispatch(captured),
      );

      expect(result.supersedesReportId).toBeUndefined();
      expect(captured[0]).toMatchObject({ type: "thread.report.post" });
      expect(captured[0]).not.toHaveProperty("supersedesReportId");
    }),
  );
});

describe("read_report supersession (handler)", () => {
  it.effect("marks a superseded report and points at the report that replaced it", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.read_report({ reportId: "report-original" }),
        {
          findByReportId: () =>
            Effect.succeed(
              Option.some(
                projectedReport({
                  reportId: "report-original",
                  summary: "Shipped the feature.",
                  supersededByReportId: "report-amendment",
                }),
              ),
            ),
        },
      );

      expect(result.supersededByReportId).toBe("report-amendment");
      // Prose as well as an id: a caller paging an old body cannot be relied
      // on to notice a field it was not looking for.
      expect(result.supersededNotice).toBe(supersededReportNotice("report-amendment"));
      expect(result.supersededNotice).toContain("report-amendment");
      // Append-only: the superseded body is still served.
      expect(result.body).toBe("Shipped the feature.");
    }),
  );

  it.effect("reads the chain from the new end without a superseded marker", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.read_report({ reportId: "report-amendment" }),
        {
          findByReportId: () =>
            Effect.succeed(
              Option.some(
                projectedReport({
                  reportId: "report-amendment",
                  summary: "Shipped the feature, plus the late instruction.",
                  supersedesReportId: "report-original",
                }),
              ),
            ),
        },
      );

      expect(result.supersedesReportId).toBe("report-original");
      expect(result.supersededByReportId).toBeUndefined();
      expect(result.supersededNotice).toBeUndefined();
    }),
  );

  it.effect("returns the amendment, unmarked, as the thread's latest report", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.read_report({ threadId: parentThreadId }),
        {
          listByThreadId: () =>
            Effect.succeed([
              projectedReport({
                reportId: "report-original",
                summary: "Shipped the feature.",
                supersededByReportId: "report-amendment",
                createdAt: "2026-08-12T01:00:00.000Z",
              }),
              projectedReport({
                reportId: "report-amendment",
                summary: "Shipped the feature, plus the late instruction.",
                supersedesReportId: "report-original",
                createdAt: "2026-08-12T02:00:00.000Z",
              }),
            ]),
        },
      );

      expect(result.reportId).toBe("report-amendment");
      expect(result.supersedesReportId).toBe("report-original");
      expect(result.supersededNotice).toBeUndefined();
    }),
  );

  it.effect("leaves an unamended report unmarked", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.read_report({ reportId: "report-standalone" }),
        {
          findByReportId: () =>
            Effect.succeed(Option.some(projectedReport({ reportId: "report-standalone" }))),
        },
      );

      expect(result.supersedesReportId).toBeUndefined();
      expect(result.supersededByReportId).toBeUndefined();
      expect(result.supersededNotice).toBeUndefined();
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

describe("list_sessions (handler)", () => {
  const strangerThreadId = "stranger-1" as ThreadId;
  const archivedChildId = "child-archived" as ThreadId;

  const strangerShell = {
    ...baseShell,
    id: strangerThreadId,
    spawnedByThreadId: null,
  } satisfies OrchestrationThreadShell;

  const archivedChildShell = {
    ...childShell,
    id: archivedChildId,
    archivedAt: now,
    settledAt: now,
  } satisfies OrchestrationThreadShell;

  it.effect("lists only this session's own spawned children, not unrelated threads", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [childShell, strangerShell],
            updatedAt: now,
          }),
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.threadId).toBe(childThreadId);
    }),
  );

  it.effect("omits archived children by default", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [childShell],
            updatedAt: now,
          }),
        getArchivedShellSnapshot: () =>
          Effect.die("getArchivedShellSnapshot must not be called without includeArchived"),
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.archived).toBe(false);
    }),
  );

  it.effect("includes archived children when includeArchived is true", () =>
    Effect.gen(function* () {
      // archivedChildShell is also settled, so state: "all" is needed here —
      // the default state: "active" would exclude it regardless of
      // includeArchived (see the state-filtering tests below).
      const result = yield* runHandler(
        (handlers) => handlers.list_sessions({ includeArchived: true, state: "all" }),
        {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [childShell],
              updatedAt: now,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [archivedChildShell],
              updatedAt: now,
            }),
        },
      );

      expect(result.sessions.map((session) => session.threadId).sort()).toEqual(
        [childThreadId, archivedChildId].sort(),
      );
      const archived = result.sessions.find((session) => session.threadId === archivedChildId);
      expect(archived?.archived).toBe(true);
      expect(archived?.settled).toBe(true);
    }),
  );

  describe("state filtering", () => {
    const activeChild = { ...childShell, id: "child-active" as ThreadId, settledAt: null };
    // Settled AND no live binding (default listBindings: []): the only case
    // that should land in "settled".
    const settledChild = {
      ...childShell,
      id: "child-settled" as ThreadId,
      settledAt: now,
      session: stoppedSession,
      worktreePath: null,
    };
    // Settled but still has a live binding (a stop-timeout escape, or a
    // session that came back to life after settling): per the shared
    // countsTowardActiveCap predicate, this must show under "active", not
    // "settled", or a spawn_limit_reached refusal would be inexplicable.
    const settledAliveChild = {
      ...childShell,
      id: "child-settled-alive" as ThreadId,
      settledAt: now,
      session: aliveSession,
    };
    const snapshotWithBoth = () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [],
        threads: [activeChild, settledChild],
        updatedAt: now,
      });

    it.effect("defaults to active, excluding a settled child with no live binding", () =>
      Effect.gen(function* () {
        const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
          getShellSnapshot: snapshotWithBoth,
        });

        expect(result.sessions.map((session) => session.threadId)).toEqual([activeChild.id]);
      }),
    );

    it.effect(
      "state: active includes a settled child with a live binding, same as the spawn cap counts it",
      () =>
        Effect.gen(function* () {
          const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [activeChild, settledChild, settledAliveChild],
                updatedAt: now,
              }),
            listBindings: bindingsFor([settledAliveChild.id]),
          });

          expect(result.sessions.map((session) => session.threadId).sort()).toEqual(
            [activeChild.id, settledAliveChild.id].sort(),
          );
          const listed = result.sessions.find(
            (session) => session.threadId === settledAliveChild.id,
          );
          // Legible, not just present: the caller can see it is settled and
          // why it still counts (sessionStatus is not a dead-looking one).
          expect(listed?.settled).toBe(true);
          expect(listed?.sessionStatus).toBe("ready");
        }),
    );

    it.effect('state: "settled" returns only children with no live binding', () =>
      Effect.gen(function* () {
        const result = yield* runHandler(
          (handlers) => handlers.list_sessions({ state: "settled" }),
          {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [activeChild, settledChild, settledAliveChild],
                updatedAt: now,
              }),
            listBindings: bindingsFor([settledAliveChild.id]),
          },
        );

        expect(result.sessions.map((session) => session.threadId)).toEqual([settledChild.id]);
        // worktreePath is the reclaimability signal for a settled child: null
        // here means send_to_session cannot resume it, only archive_session
        // remains.
        expect(result.sessions[0]?.worktreePath).toBeNull();
      }),
    );

    it.effect('state: "all" returns both active and settled children', () =>
      Effect.gen(function* () {
        const result = yield* runHandler((handlers) => handlers.list_sessions({ state: "all" }), {
          getShellSnapshot: snapshotWithBoth,
        });

        expect(result.sessions.map((session) => session.threadId).sort()).toEqual(
          [activeChild.id, settledChild.id].sort(),
        );
      }),
    );

    it.effect('state: "settled" truncates to LIST_SESSIONS_MAX_ENTRIES, most-recent first', () =>
      Effect.gen(function* () {
        const sixtySettled = Array.from(
          { length: 60 },
          (_, index) =>
            ({
              ...childShell,
              id: `settled-${index}` as ThreadId,
              settledAt: now,
              session: stoppedSession,
              createdAt: `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`,
            }) satisfies OrchestrationThreadShell,
        );

        const result = yield* runHandler(
          (handlers) => handlers.list_sessions({ state: "settled" }),
          {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: sixtySettled,
                updatedAt: now,
              }),
          },
        );

        expect(result.sessions).toHaveLength(50);
        expect(result.hasMore).toBe(true);
        // Most-recently-created first: settled-59 (00:59) is the latest,
        // settled-0..9 (the oldest 10) fall off the page.
        expect(result.sessions[0]?.threadId).toBe("settled-59");
        expect(result.sessions.map((s) => s.threadId)).not.toContain("settled-0");
      }),
    );

    it.effect('state: "settled" is most-recent-first even when the page is not truncated', () =>
      Effect.gen(function* () {
        const threeSettled = Array.from(
          { length: 3 },
          (_, index) =>
            ({
              ...childShell,
              id: `few-settled-${index}` as ThreadId,
              settledAt: now,
              session: stoppedSession,
              createdAt: `2026-08-01T00:0${index}:00.000Z`,
            }) satisfies OrchestrationThreadShell,
        );

        const result = yield* runHandler(
          (handlers) => handlers.list_sessions({ state: "settled" }),
          {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: threeSettled,
                updatedAt: now,
              }),
          },
        );

        expect(result.hasMore).toBe(false);
        expect(result.sessions.map((session) => session.threadId)).toEqual([
          "few-settled-2",
          "few-settled-1",
          "few-settled-0",
        ]);
      }),
    );

    it.effect("does not truncate state: active, even past LIST_SESSIONS_MAX_ENTRIES", () =>
      Effect.gen(function* () {
        // Active is already bounded by the spawn cap in steady state, so it
        // is intentionally not paginated the way settled/all are.
        const sixtyActive = Array.from(
          { length: 60 },
          (_, index) =>
            ({
              ...childShell,
              id: `active-${index}` as ThreadId,
              settledAt: null,
            }) satisfies OrchestrationThreadShell,
        );

        const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: sixtyActive,
              updatedAt: now,
            }),
        });

        expect(result.sessions).toHaveLength(60);
        expect(result.hasMore).toBe(false);
      }),
    );

    it.effect("state: active is also most-recent-first, same as settled/all", () =>
      Effect.gen(function* () {
        const threeActive = Array.from(
          { length: 3 },
          (_, index) =>
            ({
              ...childShell,
              id: `few-active-${index}` as ThreadId,
              settledAt: null,
              createdAt: `2026-08-01T00:0${index}:00.000Z`,
            }) satisfies OrchestrationThreadShell,
        );

        const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: threeActive,
              updatedAt: now,
            }),
        });

        expect(result.sessions.map((session) => session.threadId)).toEqual([
          "few-active-2",
          "few-active-1",
          "few-active-0",
        ]);
      }),
    );
  });

  it.effect("degrades hasReport to false when the report existence check fails", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [childShell],
            updatedAt: now,
          }),
        getThreadHasReport: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: "test", detail: "projection unavailable" }),
          ),
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.hasReport).toBe(false);
    }),
  );

  it.effect("never dispatches a command or starts a turn", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_sessions({}), {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [childShell],
            updatedAt: now,
          }),
      });
      expect(result.sessions).toHaveLength(1);
    }),
  );
});

describe("spawn_session cap (handler)", () => {
  const parentShell = {
    ...baseShell,
    id: parentThreadId,
    spawnedByThreadId: undefined,
  } satisfies OrchestrationThreadShell;

  // Session status is cosmetic here — countsTowardActiveCap consults live
  // binding presence only. eightChildren controls settledAt; boundIds
  // (passed to runSpawn) independently controls which of them the provider
  // session directory reports a live binding for.
  const eightChildren = (
    settled: boolean,
    sessionOverride: NonNullable<OrchestrationThreadShell["session"]> = stoppedSession,
  ) =>
    Array.from(
      { length: 8 },
      (_, index) =>
        ({
          ...childShell,
          id: `cap-child-${index}` as ThreadId,
          settledAt: settled ? now : null,
          session: sessionOverride,
        }) satisfies OrchestrationThreadShell,
    );

  const runSpawn = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    options: {
      readonly boundIds?: ReadonlyArray<ThreadId>;
      readonly getProjectShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
    } = {},
  ) =>
    runHandler((handlers) => handlers.spawn_session({ prompt: "Do the thing" }), {
      getThreadShellById: (id) =>
        Effect.succeed(id === parentThreadId ? Option.some(parentShell) : Option.none()),
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 0, projects: [], threads, updatedAt: now }),
      listBindings: bindingsFor(options.boundIds ?? []),
      ...(options.getProjectShellById ? { getProjectShellById: options.getProjectShellById } : {}),
    });

  it.effect("refuses a spawn once 8 active (unsettled) children exist", () =>
    Effect.gen(function* () {
      // Unsettled counts regardless of binding state — no boundIds needed.
      const error = yield* runSpawn(eightChildren(false)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationDeniedError);
      expect(error).toMatchObject({ reason: "spawn_limit_reached" });
    }),
  );

  it.effect("does not count a settled child with no live binding", () =>
    Effect.gen(function* () {
      const children = eightChildren(true);
      // Stub the next thing spawn_session touches after the cap check
      // (project lookup) to fail cleanly and distinguishably, proving the
      // cap check itself let this request through.
      const error = yield* runSpawn(children, {
        getProjectShellById: () => Effect.succeed(Option.none()),
      }).pipe(Effect.flip);

      expect(error).not.toMatchObject({ reason: "spawn_limit_reached" });
      expect((error as { message: string }).message).toContain("was not found");
    }),
  );

  it.effect("still counts a settled child that still has a live binding", () =>
    Effect.gen(function* () {
      // settleChildCascade writes settledAt unconditionally even when the
      // stop itself failed to reach "stopped" in time; a settled child is
      // not actually inactive until its provider binding is confirmed gone.
      const children = eightChildren(true, aliveSession);
      const error = yield* runSpawn(children, {
        boundIds: children.map((child) => child.id),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationDeniedError);
      expect(error).toMatchObject({ reason: "spawn_limit_reached" });
    }),
  );

  it.effect("counts a settled, errored child that still has a live binding", () =>
    Effect.gen(function* () {
      // "error" is not proof the binding is gone — Codex/OpenCode retain an
      // errored session's binding and ProviderCommandReactor can restart it.
      const children = eightChildren(true, errorSession);
      const error = yield* runSpawn(children, {
        boundIds: children.map((child) => child.id),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationDeniedError);
      expect(error).toMatchObject({ reason: "spawn_limit_reached" });
    }),
  );

  it.effect("does not count a settled, errored child with no live binding — genuinely dead", () =>
    Effect.gen(function* () {
      const children = eightChildren(true, errorSession);
      const error = yield* runSpawn(children, {
        getProjectShellById: () => Effect.succeed(Option.none()),
      }).pipe(Effect.flip);

      expect(error).not.toMatchObject({ reason: "spawn_limit_reached" });
      expect((error as { message: string }).message).toContain("was not found");
    }),
  );

  it.effect("refuses a spawn once 32 total (active + settled) children are retained", () =>
    Effect.gen(function* () {
      const thirtyTwo = Array.from(
        { length: 32 },
        (_, index) =>
          ({
            ...childShell,
            id: `retained-child-${index}` as ThreadId,
            // All settled with no live binding, so the 8-active cap alone
            // would not refuse this spawn; only the 32-retention cap should.
            settledAt: now,
            session: stoppedSession,
          }) satisfies OrchestrationThreadShell,
      );
      const error = yield* runSpawn(thirtyTwo).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SessionOrchestrationDeniedError);
      expect(error).toMatchObject({ reason: "spawn_retention_limit_reached" });
    }),
  );
});
