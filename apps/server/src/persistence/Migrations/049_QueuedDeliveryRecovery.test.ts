import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const sqliteLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(sqliteLayer);

layer("049_QueuedDeliveryRecovery", (it) => {
  it.effect("adds durable marker and redelivery columns", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 49 });
      const sql = yield* SqlClient.SqlClient;
      const sessionColumns = yield* sql`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      const turnColumns = yield* sql`
        SELECT name FROM pragma_table_info('projection_turns')
      `;
      assert.isTrue(sessionColumns.some((column) => column.name === "queued_delivery_message_id"));
      assert.isTrue(turnColumns.some((column) => column.name === "redelivery_count"));
    }),
  );
});
