/**
 * LimitFailoverReactor - Automatic account failover reactor service interface.
 *
 * Owns the background worker that reacts to usage-limit classified session
 * errors on instances with a failover group, migrating affected threads to
 * the group member with the most remaining quota and retrying the failed
 * turn.
 *
 * @module LimitFailoverReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface LimitFailoverReactorShape {
  /**
   * Start reacting to usage-limit session errors.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves once the queue is empty and nothing is in flight.
   *
   * Failover reacts to events nobody awaits, so this is how a caller — a test,
   * in practice — observes that a limit signal has been fully considered
   * instead of sleeping and hoping.
   */
  readonly drain: Effect.Effect<void>;
}

export class LimitFailoverReactor extends Context.Service<
  LimitFailoverReactor,
  LimitFailoverReactorShape
>()("t3/orchestration/Services/LimitFailoverReactor") {}
