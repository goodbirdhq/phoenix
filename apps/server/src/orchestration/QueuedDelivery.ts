import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/** Serializes delivery acceptance with cancellation and recovery for one thread. */
export class QueuedDelivery extends Context.Service<
  QueuedDelivery,
  {
    readonly withPermit: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration/QueuedDelivery") {}

export const layer = Layer.sync(QueuedDelivery, () => {
  const permits = new Map<ThreadId, { semaphore: Semaphore.Semaphore; users: number }>();
  const withPermit: QueuedDelivery["Service"]["withPermit"] = (threadId, effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = permits.get(threadId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        permits.set(threadId, entry);
        return entry;
      }),
      (entry) => entry.semaphore.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) permits.delete(threadId);
        }),
    );
  return { withPermit };
});

/** Keeps unrelated sessions moving while one provider is accepting an input. */
export const makeWorker = <A>(
  threadIdOf: (input: A) => ThreadId,
  process: (input: A) => Effect.Effect<void, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope;
    const lanes = new Map<
      ThreadId,
      {
        worker: DrainableWorker<A>;
        scope: Scope.Closeable;
        pending: number;
      }
    >();
    const router = yield* makeDrainableWorker<A, never, never>((input) =>
      Effect.gen(function* () {
        const threadId = threadIdOf(input);
        let lane = lanes.get(threadId);
        if (lane === undefined) {
          // Retain only a small idle cache. Busy lanes remain until their work drains.
          if (lanes.size >= 256) {
            for (const [id, candidate] of lanes) {
              if (candidate.pending !== 0) continue;
              lanes.delete(id);
              yield* Scope.close(candidate.scope, Exit.void);
              if (lanes.size < 256) break;
            }
          }
          const scope = yield* Scope.fork(parentScope, "sequential");
          const state = { pending: 0 };
          const worker = yield* makeDrainableWorker<A, never, never>((item) =>
            process(item).pipe(
              Scope.provide(parentScope),
              Effect.ensuring(
                Effect.sync(() => {
                  state.pending--;
                }),
              ),
            ),
          ).pipe(Scope.provide(scope));
          lane = Object.assign(state, { worker, scope });
          lanes.set(threadId, lane);
        }
        lane.pending++;
        yield* lane.worker.enqueue(input);
      }),
    );
    return {
      enqueue: router.enqueue,
      drain: Effect.gen(function* () {
        yield* router.drain;
        yield* Effect.forEach(lanes.values(), (lane) => lane.worker.drain, {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    } satisfies DrainableWorker<A>;
  });
