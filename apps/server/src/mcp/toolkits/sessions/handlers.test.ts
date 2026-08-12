import { describe, expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
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
