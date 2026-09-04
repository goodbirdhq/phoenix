import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("059_SessionEpisodeAndQueuedStateIndex", (it) => {
  it.effect("adds the episode boundary and active-delivery scan index idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* runMigrations({ toMigrationInclusive: 59 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(columns.some((column) => column.name === "episode_started_at"));
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_turns_active_delivery_state"),
      );
    }),
  );
});
