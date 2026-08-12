import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionThreadSessionStopAudit", (it) => {
  it.effect("adds persisted session stop audit columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      for (const name of [
        "stopped_by",
        "stop_requested_at",
        "stop_reason",
        "interrupted_tool_call",
        "last_completed_operation",
        "grace_stop_deadline_at",
        "grace_stop_episode_id",
      ]) {
        assert.isTrue(columns.some((column) => column.name === name));
      }
    }),
  );
});
