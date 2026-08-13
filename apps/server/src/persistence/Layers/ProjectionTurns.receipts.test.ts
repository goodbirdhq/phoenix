import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";

const THREAD_ID = ThreadId.make("receipt-thread");
const MESSAGE_ID = MessageId.make("receipt-message");
const REQUESTED_AT = "2026-01-01T00:00:00.000Z";
const RELEASING_AT = "2026-01-01T00:00:30.000Z";

const sqliteLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.merge(sqliteLayer, ProjectionTurnRepositoryLive.pipe(Layer.provide(sqliteLayer))),
);

layer("ProjectionTurnRepository queued receipts", (it) => {
  it.effect("round-trips releasing rows, requeues them, and returns durable receipts", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 47 });
      const repository = yield* ProjectionTurnRepository;
      yield* repository.enqueueTurnStart({
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        mode: "queue",
        state: "queued",
        requestedAt: REQUESTED_AT,
        releasingAt: null,
      });
      yield* repository.markQueuedTurnStartReleasing({
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        releasingAt: RELEASING_AT,
      });

      assert.deepEqual(yield* repository.listQueuedTurnStarts, [
        {
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          mode: "queue",
          state: "releasing",
          requestedAt: REQUESTED_AT,
          releasingAt: RELEASING_AT,
        },
      ]);

      yield* repository.requeueQueuedTurnStart({ threadId: THREAD_ID, messageId: MESSAGE_ID });
      assert.deepEqual(yield* repository.listQueuedTurnStarts, [
        {
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          mode: "queue",
          state: "queued",
          requestedAt: REQUESTED_AT,
          releasingAt: null,
        },
      ]);

      yield* repository.markQueuedTurnStartReleasing({
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        releasingAt: RELEASING_AT,
      });
      yield* repository.consumeQueuedTurnStart({
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        turnId: TurnId.make("receipt-turn"),
        consumedAt: "2026-01-01T00:01:00.000Z",
      });
      const receipts = yield* repository.listQueuedDeliveryReceipts({
        threadId: THREAD_ID,
        limit: 20,
      });
      assert.equal(receipts[0]?.state, "consumed");
      assert.equal(receipts[0]?.consumedByTurnId, TurnId.make("receipt-turn"));
    }),
  );
});
