import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PolledRead from "./PolledRead.ts";

/**
 * A source keyed by `current`. Each read is announced on `started` and `finished`, and waits
 * while held, so tests decide when reads overlap and know when they are done.
 */
const makeSource = Effect.gen(function* () {
  const current = yield* Ref.make("a");
  const started = yield* Queue.unbounded<string>();
  const finished = yield* Queue.unbounded<string>();
  const gate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  let reads = 0;
  const read = (key: string) =>
    Effect.gen(function* () {
      reads += 1;
      const read = reads;
      yield* Queue.offer(started, key);
      const wait = yield* Ref.get(gate);
      if (wait !== null) yield* Deferred.await(wait);
      yield* Queue.offer(finished, key);
      return `${key}:${read}`;
    });
  return {
    current,
    started,
    finished,
    reads: () => reads,
    read,
    /** Holds every read from now until the returned effect releases them. */
    hold: Effect.gen(function* () {
      const wait = yield* Deferred.make<void>();
      yield* Ref.set(gate, wait);
      return Ref.set(gate, null).pipe(Effect.andThen(Deferred.succeed(wait, undefined)));
    }),
  };
});

const makePolled = (
  source: Effect.Success<typeof makeSource>,
  refreshWhen?: Stream.Stream<unknown>,
) =>
  PolledRead.make({
    input: Ref.get(source.current),
    key: (key: string) => key,
    read: source.read,
    interval: "1 minute",
    ...(refreshWhen === undefined ? {} : { refreshWhen }),
  });

it.effect("polls only while watched, with one poller however many watch", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const polled = yield* makePolled(source);
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(source.reads(), 0);

    const first = yield* Scope.make();
    const second = yield* Scope.make();
    yield* polled.watch.pipe(Scope.provide(first));
    yield* polled.watch.pipe(Scope.provide(second));
    yield* Queue.take(source.started);
    assert.strictEqual(source.reads(), 1);
    yield* TestClock.adjust("1 minute");
    yield* Queue.take(source.started);
    assert.strictEqual(source.reads(), 2);

    // The poller outlives the first watcher and stops with the last.
    yield* Scope.close(first, Exit.void);
    yield* TestClock.adjust("1 minute");
    yield* Queue.take(source.started);
    yield* Scope.close(second, Exit.void);
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(source.reads(), 3);
  }).pipe(Effect.scoped),
);

it.effect("shares one read between overlapping refreshes of the same key", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const polled = yield* makePolled(source);
    const release = yield* source.hold;
    const first = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Queue.take(source.started);
    const second = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* release;
    assert.strictEqual(yield* Fiber.join(first), "a:1");
    assert.strictEqual(yield* Fiber.join(second), "a:1");
    // Once it finished, the next refresh reads again.
    assert.strictEqual(yield* polled.refresh, "a:2");
  }).pipe(Effect.scoped),
);

it.effect("replaces a read whose key changed, so the old answer never lands as the new", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const polled = yield* makePolled(source);
    const release = yield* source.hold;
    const old = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Queue.take(source.started);
    yield* Ref.set(source.current, "b");
    const replacement = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Queue.take(source.started);
    yield* release;
    assert.strictEqual(yield* Fiber.join(replacement), "b:2");
    assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(old)));
  }).pipe(Effect.scoped),
);

it.effect("finishes a read for the others when one caller goes away", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const polled = yield* makePolled(source);
    const release = yield* source.hold;
    const leaving = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Queue.take(source.started);
    const staying = yield* polled.refresh.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.interrupt(leaving);
    yield* release;
    assert.strictEqual(yield* Fiber.join(staying), "a:1");
    assert.strictEqual(source.reads(), 1);
  }).pipe(Effect.scoped),
);

it.effect("reads on each refreshWhen element, only while watched", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const triggers = yield* Queue.unbounded<void>();
    const polled = yield* makePolled(source, Stream.fromQueue(triggers));
    const watching = yield* Scope.make();
    yield* polled.watch.pipe(Scope.provide(watching));
    yield* Queue.take(source.finished);
    yield* Queue.offer(triggers, undefined);
    yield* Queue.take(source.finished);
    assert.strictEqual(source.reads(), 2);
    yield* Scope.close(watching, Exit.void);
    yield* Queue.offer(triggers, undefined);
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(source.reads(), 2);
  }).pipe(Effect.scoped),
);

it.effect("refreshes in the background only while watched", () =>
  Effect.gen(function* () {
    const source = yield* makeSource;
    const polled = yield* makePolled(source);
    yield* polled.refreshIfWatched;
    yield* TestClock.adjust("1 second");
    assert.strictEqual(source.reads(), 0);

    yield* polled.watch;
    yield* Queue.take(source.finished);
    yield* polled.refreshIfWatched;
    yield* Queue.take(source.finished);
    assert.strictEqual(source.reads(), 2);
  }).pipe(Effect.scoped),
);
