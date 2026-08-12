import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionThreadReportSupersedes", (it) => {
  it.effect("adds a nullable supersedes link and its lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_thread_reports)
      `;
      const column = columns.find((entry) => entry.name === "supersedes_report_id");
      assert.isDefined(column);
      // Nullable with no default: reports that predate amendments — every one
      // already stored — supersede nothing, and must keep decoding.
      assert.strictEqual(column?.notnull, 0);
      assert.isNull(column?.dflt_value ?? null);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_reports)
      `;
      assert.isTrue(
        indexes.some(
          (entry) => entry.name === "idx_projection_thread_reports_supersedes_report_id",
        ),
      );
    }),
  );

  it.effect("leaves reports written before the migration superseding nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO projection_thread_reports (
          report_id,
          thread_id,
          status,
          title,
          summary,
          artifacts_json,
          created_at
        )
        VALUES (
          'report-pre-migration',
          'thread-1',
          'success',
          'Did the work',
          'All done.',
          '[]',
          '2026-08-12T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const rows = yield* sql<{ readonly supersedes_report_id: string | null }>`
        SELECT supersedes_report_id
        FROM projection_thread_reports
        WHERE report_id = 'report-pre-migration'
      `;
      assert.strictEqual(rows.length, 1);
      assert.isNull(rows[0]?.supersedes_report_id ?? null);
    }),
  );
});
