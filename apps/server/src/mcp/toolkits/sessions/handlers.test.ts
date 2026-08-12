import { describe, expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  assessWorktreeCleanupRisk,
  decideBranchCleanup,
  isSessionBusy,
  resolveSendToSessionDelivery,
  resolveSessionCheckout,
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
