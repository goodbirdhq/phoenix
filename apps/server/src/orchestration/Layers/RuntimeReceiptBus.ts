/**
 * RuntimeReceiptBus layers.
 *
 * Receipts are ephemeral and fan out only to active in-process subscribers;
 * they are never persisted or retained for future subscribers.
 *
 * @module RuntimeReceiptBus
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get streamEvents() {
      return Stream.fromPubSub(pubSub);
    },
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTest = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
