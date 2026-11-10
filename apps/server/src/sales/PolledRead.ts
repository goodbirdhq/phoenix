import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * A read of a remote source that many callers share and that polls only while someone watches.
 *
 * - **One read per key.** `refresh` joins a read already in flight for the same key. A read for
 *   another key (the settings changed while it ran) is interrupted and replaced, so the old
 *   source's answer never lands as the new one's.
 * - **Reads outlive their callers.** A read runs in the scope `make` was given, so a caller that
 *   goes away does not cancel it for the others waiting on it.
 * - **Polls while watched.** The first `watch` starts one poller (a read, then `interval`, again,
 *   plus a read on each `refreshWhen` element); the last one to leave stops it.
 *
 * `read` must not fail: a source's failures belong in what it returns, so that watchers keep
 * the last answer and see the error beside it.
 */
export interface PolledRead<A> {
  /** Reads now, or joins the read in flight for the current key, and returns its answer. */
  readonly refresh: Effect.Effect<A>;
  /** Keeps the poller running while the scope is open. */
  readonly watch: Effect.Effect<void, never, Scope.Scope>;
  /** Starts a read in the background when someone watches, and does nothing otherwise. */
  readonly refreshIfWatched: Effect.Effect<void>;
}

export const make = Effect.fn("PolledRead.make")(function* <I, A>(options: {
  /** What to read with now, such as the current settings. */
  readonly input: Effect.Effect<I>;
  /** Inputs with the same key read the same source. */
  readonly key: (input: I) => string;
  readonly read: (input: I) => Effect.Effect<A>;
  readonly interval: Duration.Input;
  /** Extra moments to read at while watched, such as a settings change. */
  readonly refreshWhen?: Stream.Stream<unknown>;
}) {
  const scope = yield* Effect.scope;
  // Holding the lock while interrupting a replaced read is safe: a read never touches this ref.
  const inFlight = yield* SynchronizedRef.make<{
    readonly key: string;
    readonly fiber: Fiber.Fiber<A>;
  } | null>(null);
  const poller = yield* SynchronizedRef.make<{
    readonly watchers: number;
    readonly fiber: Fiber.Fiber<void> | null;
  }>({ watchers: 0, fiber: null });

  const refresh = Effect.gen(function* () {
    const input = yield* options.input;
    const key = options.key(input);
    const fiber = yield* SynchronizedRef.modifyEffect(inFlight, (current) =>
      Effect.gen(function* () {
        if (current !== null && current.key === key && current.fiber.pollUnsafe() === undefined) {
          return [current.fiber, current] as const;
        }
        if (current !== null) yield* Fiber.interrupt(current.fiber);
        const next = yield* options.read(input).pipe(Effect.forkIn(scope));
        return [next, { key, fiber: next }] as const;
      }),
    );
    return yield* Fiber.join(fiber);
  });

  const pollLoop = Effect.all(
    [
      refresh.pipe(Effect.andThen(Effect.sleep(options.interval)), Effect.forever),
      (options.refreshWhen ?? Stream.empty).pipe(Stream.runForEach(() => refresh)),
    ],
    { concurrency: "unbounded", discard: true },
  );

  const attach = SynchronizedRef.updateEffect(poller, (current) =>
    current.watchers > 0
      ? Effect.succeed({ ...current, watchers: current.watchers + 1 })
      : pollLoop.pipe(
          Effect.forkIn(scope),
          Effect.map((fiber) => ({ watchers: 1, fiber })),
        ),
  );
  const detach = SynchronizedRef.updateEffect(poller, (current) =>
    current.watchers > 1
      ? Effect.succeed({ ...current, watchers: current.watchers - 1 })
      : (current.fiber === null ? Effect.void : Fiber.interrupt(current.fiber)).pipe(
          Effect.as({ watchers: 0, fiber: null }),
        ),
  );

  return {
    refresh,
    watch: Effect.acquireRelease(attach, () => detach),
    refreshIfWatched: SynchronizedRef.get(poller).pipe(
      Effect.flatMap((current) =>
        current.watchers > 0 ? refresh.pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void,
      ),
    ),
  } satisfies PolledRead<A>;
});
