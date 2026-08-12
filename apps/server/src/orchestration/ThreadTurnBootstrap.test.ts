import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { resolveWorktreeCheckoutCommit } from "./ThreadTurnBootstrap.ts";

describe("resolveWorktreeCheckoutCommit", () => {
  it("reports an origin fetch failure without calling it a missing ref", async () => {
    const error = await Effect.runPromiseExit(
      resolveWorktreeCheckoutCommit(
        {
          resolveCommit: () => Effect.fail(new Error("unknown revision")),
          remoteExists: () => Effect.succeed(true),
          fetchRemote: () => Effect.fail(new Error("authentication failed")),
          fetchPullRequestHeadCommit: () => Effect.die("not used"),
        },
        { cwd: "/repo", checkoutRef: "feature/review" },
      ),
    );

    expect(Exit.isFailure(error)).toBe(true);
    if (Exit.isFailure(error)) {
      expect(error.cause).toMatchObject({
        error: expect.objectContaining({
          message:
            'Failed to fetch origin while resolving git ref "feature/review": authentication failed',
        }),
      });
    }
  });

  it("reports a missing ref only after a successful fetch", async () => {
    let resolveAttempts = 0;
    const error = await Effect.runPromiseExit(
      resolveWorktreeCheckoutCommit(
        {
          resolveCommit: () => {
            resolveAttempts += 1;
            return Effect.fail(new Error("unknown revision"));
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
      expect(error.cause).toMatchObject({
        error: expect.objectContaining({
          message: 'Git ref "feature/review" does not exist locally or on origin.',
        }),
      });
    }
  });
});
