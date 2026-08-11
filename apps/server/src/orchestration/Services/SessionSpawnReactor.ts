/**
 * SessionSpawnReactor - Parent wake-up for spawned sessions.
 *
 * Watches domain events for threads that were spawned by another thread's
 * agent session (sessions MCP toolkit). When a spawned thread posts a
 * completion report, or its provider session lands in an error state, the
 * reactor starts a turn on the spawning thread carrying that outcome — so an
 * orchestrating session is woken instead of having to poll its children.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SessionSpawnReactorShape {
  /**
   * Start reacting to spawned-thread completion domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class SessionSpawnReactor extends Context.Service<
  SessionSpawnReactor,
  SessionSpawnReactorShape
>()("t3/orchestration/Services/SessionSpawnReactor") {}
