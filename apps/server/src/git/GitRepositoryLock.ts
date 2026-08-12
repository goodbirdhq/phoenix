import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
     * Run `effect` holding the lock for `repositoryRoot`.
     *
     * Keyed on the path as given (trailing separators normalized), which is
     * the project's workspace root everywhere this is used today. Different
     * repositories never contend.
     */
    readonly withRepositoryLock: <A, E, R>(
      repositoryRoot: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/git/GitRepositoryLock") {}

const normalizeRepositoryKey = (repositoryRoot: string) =>
  repositoryRoot.trim().replace(/[/\\]+$/, "");

export const make = Effect.gen(function* () {
  const locksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

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
    repositoryRoot,
    effect,
  ) =>
    Effect.flatMap(getLock(normalizeRepositoryKey(repositoryRoot)), (lock) =>
      lock.withPermits(1)(effect),
    );

  return GitRepositoryLock.of({ withRepositoryLock });
});

export const layer = Layer.effect(GitRepositoryLock, make);
