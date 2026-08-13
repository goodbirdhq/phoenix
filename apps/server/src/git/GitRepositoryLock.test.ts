/**
 * The lock is only worth having if two names for one repository land on one
 * permit. Keying on the path as handed in looked fine in a test that passed
 * the same string twice, and serialized nothing the moment a caller reached
 * the repo through a symlink or from inside a linked worktree.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GitRepositoryLock,
  layer as gitRepositoryLockLayer,
  parseWorktreeGitDir,
  toGitCommonDir,
} from "./GitRepositoryLock.ts";

// provideMerge, so the lock gets the real filesystem it canonicalizes keys
// through and the tests keep access to it for building fixtures.
const TestLayer = gitRepositoryLockLayer.pipe(Layer.provideMerge(NodeServices.layer));

/** A repository root: a directory whose `.git` is a directory. */
const makeRepository = Effect.fn("makeRepository")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-repo-lock-" });
  yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
  return root;
});

describe("parseWorktreeGitDir", () => {
  it("reads the gitdir pointer a linked worktree leaves in .git", () => {
    expect(parseWorktreeGitDir("gitdir: /repo/.git/worktrees/feature-x\n")).toBe(
      "/repo/.git/worktrees/feature-x",
    );
    expect(parseWorktreeGitDir("gitdir: ../../.git/worktrees/feature-x")).toBe(
      "../../.git/worktrees/feature-x",
    );
  });

  it("ignores anything that is not a gitdir pointer", () => {
    expect(parseWorktreeGitDir("")).toBeNull();
    expect(parseWorktreeGitDir("ref: refs/heads/main")).toBeNull();
  });
});

describe("toGitCommonDir", () => {
  it("reduces a worktree admin directory to the shared common directory", () => {
    expect(toGitCommonDir("/repo/.git/worktrees/feature-x")).toBe("/repo/.git");
    expect(toGitCommonDir("/repo/.git/worktrees/feature-x/")).toBe("/repo/.git");
  });

  it("leaves a common directory alone", () => {
    expect(toGitCommonDir("/repo/.git")).toBe("/repo/.git");
    // A repository that merely has a branch named "worktrees/..." is not a
    // linked worktree and must not be truncated.
    expect(toGitCommonDir("/repo/.git/modules/sub")).toBe("/repo/.git/modules/sub");
  });
});

describe("GitRepositoryLock keying", () => {
  it.effect("gives a symlinked alias of one repository the same key", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* makeRepository();
      const aliasParent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-repo-alias-" });
      const path = yield* Path.Path;
      const alias = path.join(aliasParent, "repo-link");
      yield* fileSystem.symlink(root, alias);

      const lock = yield* GitRepositoryLock;
      const rootKey = yield* lock.resolveRepositoryKey(root);
      const aliasKey = yield* lock.resolveRepositoryKey(alias);

      assert.strictEqual(aliasKey, rootKey);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("gives a linked worktree the same key as its repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRepository();
      // The layout `git worktree add` produces: the worktree's `.git` is a
      // file pointing into the main repository's admin directory.
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-repo-worktree-" });
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${path.join(root, ".git", "worktrees", "feature-x")}\n`,
      );

      const lock = yield* GitRepositoryLock;
      assert.strictEqual(
        yield* lock.resolveRepositoryKey(worktree),
        yield* lock.resolveRepositoryKey(root),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps unrelated repositories on separate keys", () =>
    Effect.gen(function* () {
      const first = yield* makeRepository();
      const second = yield* makeRepository();
      const lock = yield* GitRepositoryLock;

      assert.notStrictEqual(
        yield* lock.resolveRepositoryKey(first),
        yield* lock.resolveRepositoryKey(second),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("serializes work reaching one repository through two different paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRepository();
      const aliasParent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-repo-alias-" });
      const alias = path.join(aliasParent, "repo-link");
      yield* fileSystem.symlink(root, alias);

      const lock = yield* GitRepositoryLock;
      let inFlight = 0;
      let maxInFlight = 0;
      const critical = Effect.gen(function* () {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        inFlight -= 1;
      });

      yield* Effect.all(
        [
          lock.withRepositoryLock(root, critical),
          lock.withRepositoryLock(alias, critical),
          lock.withRepositoryLock(path.join(root, "."), critical),
        ],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(maxInFlight, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("still locks a path that is not a repository at all", () =>
    Effect.gen(function* () {
      // Degrading to the real path keeps the lock usable for a project that is
      // not a git repository; refusing to key it would be worse than coarse.
      const fileSystem = yield* FileSystem.FileSystem;
      const plain = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-repo-plain-" });
      const lock = yield* GitRepositoryLock;

      const key = yield* lock.resolveRepositoryKey(plain);
      assert.strictEqual(key, yield* fileSystem.realPath(plain));
    }).pipe(Effect.provide(TestLayer)),
  );
});
