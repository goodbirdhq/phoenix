import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_ProjectionThreadSessionErrorKind", (it) => {
  it.effect("adds the durable session error kind column", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 51 });
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.isTrue(columns.some((column) => column.name === "last_error_kind"));
    }),
  );
});
