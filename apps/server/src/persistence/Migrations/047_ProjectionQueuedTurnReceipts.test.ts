import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionQueuedTurnReceipts", (it) => {
  it.effect("adds queued-delivery receipt columns and index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_turns)`;
      for (const name of [
        "releasing_at",
        "consumed_by_turn_id",
        "consumed_at",
        "cancelled_at",
        "cancel_reason",
      ]) {
        assert.isTrue(columns.some((column) => column.name === name));
      }
      const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(projection_turns)`;
      assert.isTrue(
        indexes.some((index) => index.name === "idx_projection_turns_receipts_thread_recent"),
      );
    }),
  );
});
