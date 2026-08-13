import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

/**
 * Serializes git commands that take the repository's index/ref locks.
 *
 * Git does not queue: two `git worktree remove` runs against one repository
 * race for `.git/index.lock`, and the loser does not fail fast — it blocks
 * until our own command timeout kills it, which is how eight parallel
 * settle_session cleanups all timed out while one succeeded. Worse, a git
 * process killed mid-write leaves the lock file behind and every later git
 * command on that repository fails until someone removes it by hand.
 *
 * So mutating worktree/branch work funnels through one permit per repository.
 * Reads (status, rev-parse) stay unserialized: they do not take the lock.
 */
export class GitRepositoryLock extends Context.Service<
  GitRepositoryLock,
  {
    /**
     * Run `effect` holding the lock for the repository containing `path`.
     *
     * `path` may be any directory inside the repository — a project root, or a
     * linked worktree. What matters is that two paths naming the same
     * repository end up on the same permit (see {@link resolveRepositoryKey}).
     */
    readonly withRepositoryLock: <A, E, R>(
      path: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** The canonical key `path` locks on. Exposed for tests and diagnostics. */
    readonly resolveRepositoryKey: (path: string) => Effect.Effect<string>;
  }
>()("t3/git/GitRepositoryLock") {}

/**
 * Pull the git directory out of a linked worktree's `.git` file.
 *
 * A linked worktree's `.git` is a file, not a directory:
 * `gitdir: /repo/.git/worktrees/feature-x`. Everything up to `/worktrees/` is
 * the common directory every worktree of that repository shares — which is
 * exactly the thing whose locks contend.
 */
export function parseWorktreeGitDir(contents: string): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  const gitDir = match?.[1];
  return gitDir === undefined || gitDir.length === 0 ? null : gitDir;
}

/**
 * Reduce a git directory to the common directory shared by every worktree.
 *
 * `/repo/.git/worktrees/feature-x` → `/repo/.git`; a path with no
 * `worktrees/` segment is already common and passes through.
 */
export function toGitCommonDir(gitDir: string): string {
  const marker = /[/\\]worktrees[/\\][^/\\]+[/\\]?$/;
  return gitDir.replace(marker, "");
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const keysRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  /**
   * The identity two callers must agree on to contend for the same permit.
   *
   * Keying on the path as given would hand `/tmp/repo` and its symlink
   * `/link/repo` — or a project root and one of its worktrees — different
   * semaphores, which serializes nothing and leaves the original bug intact.
   * So: resolve symlinks, then resolve the repository's common git directory.
   * Every step degrades to the best answer so far, because a lock keyed on a
   * slightly coarser path is still correct; failing here is not.
   */
  const resolveRepositoryKeyUncached = Effect.fn("GitRepositoryLock.resolveRepositoryKey")(
    function* (input: string) {
      const resolved = path.resolve(input);
      const realRoot = yield* fileSystem
        .realPath(resolved)
        .pipe(Effect.orElseSucceed(() => resolved));

      const gitPath = path.join(realRoot, ".git");
      const info = yield* Effect.option(fileSystem.stat(gitPath));
      if (Option.isNone(info)) {
        // Not a repository root (or unreadable): the real path is the best
        // identity available, and two callers naming it still agree.
        return realRoot;
      }

      if (info.value.type === "Directory") {
        return yield* fileSystem.realPath(gitPath).pipe(Effect.orElseSucceed(() => gitPath));
      }

      const contents = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const gitDir = parseWorktreeGitDir(contents);
      if (gitDir === null) {
        return realRoot;
      }
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(realRoot, gitDir);
      const commonDir = toGitCommonDir(absoluteGitDir);
      return yield* fileSystem.realPath(commonDir).pipe(Effect.orElseSucceed(() => commonDir));
    },
  );

  // Repository layout does not move under a running server, so the mapping is
  // resolved once per distinct input path rather than on every cleanup.
  const resolveRepositoryKey = (input: string) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(keysRef)).get(input);
      if (cached !== undefined) {
        return cached;
      }
      const key = yield* resolveRepositoryKeyUncached(input);
      yield* Ref.update(keysRef, (keys) => new Map(keys).set(input, key));
      return key;
    });

  // Two fibers can build a semaphore for the same key concurrently; the
  // Ref.modify below picks one winner and the loser's spare is discarded, so
  // every caller ends up waiting on the same permit.
  const getLock = Effect.fn("GitRepositoryLock.getLock")(function* (key: string) {
    const existing = (yield* Ref.get(locksRef)).get(key);
    if (existing) {
      return existing;
    }
    const lock = yield* Semaphore.make(1);
    return yield* Ref.modify(locksRef, (locks) => {
      const current = locks.get(key);
      if (current) {
        return [current, locks] as const;
      }
      const next = new Map(locks);
      next.set(key, lock);
      return [lock, next] as const;
    });
  });

  const withRepositoryLock: GitRepositoryLock["Service"]["withRepositoryLock"] = (
    repositoryPath,
    effect,
  ) =>
    Effect.flatMap(Effect.flatMap(resolveRepositoryKey(repositoryPath), getLock), (lock) =>
      lock.withPermits(1)(effect),
    );

  return GitRepositoryLock.of({ withRepositoryLock, resolveRepositoryKey });
});

export const layer = Layer.effect(GitRepositoryLock, make);
