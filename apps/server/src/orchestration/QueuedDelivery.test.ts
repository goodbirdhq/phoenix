import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { layer, makeWorker, QueuedDelivery } from "./QueuedDelivery.ts";

it.effect("a blocked delivery preserves its thread's order without blocking another thread", () =>
  Effect.gen(function* () {
    const delivery = yield* QueuedDelivery;
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const entered = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<void>();
    const otherReported = yield* Deferred.make<void>();
    const order: string[] = [];
    const sending = yield* delivery
      .withPermit(
        a,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(accepted);
          order.push("accepted");
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const worker = yield* makeWorker(
      (item: { threadId: ThreadId; label: string }) => item.threadId,
      (item) =>
        delivery.withPermit(
          item.threadId,
          Effect.gen(function* () {
            order.push(item.label);
            if (item.threadId === b) yield* Deferred.succeed(otherReported, undefined);
          }),
        ),
    );
    yield* worker.enqueue({ threadId: a, label: "cancel" });
    yield* worker.enqueue({ threadId: a, label: "next" });
    yield* worker.enqueue({ threadId: b, label: "report" });
    const draining = yield* worker.drain.pipe(Effect.forkChild);
    yield* Deferred.await(otherReported);
    assert.deepEqual(order, ["report"]);
    assert.equal(draining.pollUnsafe(), undefined);
    yield* Deferred.succeed(accepted, undefined);
    yield* Fiber.join(sending);
    yield* Fiber.join(draining);
    assert.deepEqual(order, ["report", "accepted", "cancel", "next"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
