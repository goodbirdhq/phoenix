import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("052_Schedules", (it) => {
  it.effect("creates durable Schedule definitions, Occurrences, receipts, and events", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 51 });
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'schedule_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        ["schedule_commands", "schedule_definitions", "schedule_events", "schedule_occurrences"],
      );

      const occurrenceColumns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`SELECT name, "notnull" FROM pragma_table_info('schedule_occurrences')`;
      const threadId = occurrenceColumns.find(({ name }) => name === "thread_id");
      assert.strictEqual(threadId?.notnull, 0);
    }),
  );
});
