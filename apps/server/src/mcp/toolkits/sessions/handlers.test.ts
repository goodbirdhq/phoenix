import { describe, expect, it } from "@effect/vitest";
import {
  GitCommandError,
  READ_REPORT_MAX_CHARS,
  ReadReportInput,
  SESSION_REPORT_INLINE_MAX_CHARS,
  type SessionReport,
  ThreadId,
  toSessionReportEnvelope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  assessWorktreeCleanupRisk,
  canReadThreadReports,
  decideBranchCleanup,
  isSessionAlive,
  isSessionBusy,
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
  it("returns null when optional checkout metadata cannot be read", async () => {
    const checkout = await Effect.runPromise(
      resolveSessionCheckout(
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
      ),
    );

    expect(checkout).toBeNull();
  });
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
