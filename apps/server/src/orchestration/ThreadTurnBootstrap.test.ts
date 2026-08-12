import { describe, expect, it } from "vite-plus/test";
import { GitCommandError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { resolveWorktreeCheckoutCommit } from "./ThreadTurnBootstrap.ts";

const gitError = (detail: string) =>
  new GitCommandError({ operation: "test", command: "git", cwd: "/repo", detail });
const isGitCommandError = Schema.is(GitCommandError);

describe("resolveWorktreeCheckoutCommit", () => {
  it("reports an origin fetch failure without calling it a missing ref", async () => {
    const error = await Effect.runPromiseExit(
      resolveWorktreeCheckoutCommit(
        {
          resolveCommit: () => Effect.fail(gitError("unknown revision")),
          remoteExists: () => Effect.succeed(true),
          fetchRemote: () => Effect.fail(gitError("authentication failed")),
          fetchPullRequestHeadCommit: () => Effect.die("not used"),
        },
        { cwd: "/repo", checkoutRef: "feature/review" },
      ),
    );

    expect(Exit.isFailure(error)).toBe(true);
    if (Exit.isFailure(error)) {
      const squashed = Cause.squash(error.cause);
      expect(squashed).toBeInstanceOf(GitCommandError);
      if (isGitCommandError(squashed)) {
        expect(squashed.detail).toBe(
          'Failed to fetch origin while resolving git ref "feature/review": Git command failed in test (/repo): authentication failed',
        );
      }
    }
  });

  it("reports a missing ref only after a successful fetch", async () => {
    let resolveAttempts = 0;
    const error = await Effect.runPromiseExit(
      resolveWorktreeCheckoutCommit(
        {
          resolveCommit: () => {
            resolveAttempts += 1;
            return Effect.fail(gitError("unknown revision"));
          },
          remoteExists: () => Effect.succeed(true),
          fetchRemote: () => Effect.void,
          fetchPullRequestHeadCommit: () => Effect.die("not used"),
        },
        { cwd: "/repo", checkoutRef: "feature/review" },
      ),
    );

    expect(resolveAttempts).toBe(2);
    expect(Exit.isFailure(error)).toBe(true);
    if (Exit.isFailure(error)) {
      const squashed = Cause.squash(error.cause);
      expect(squashed).toBeInstanceOf(GitCommandError);
      if (isGitCommandError(squashed)) {
        expect(squashed.detail).toBe(
          'Git ref "feature/review" does not exist locally or on origin.',
        );
      }
    }
  });
});
