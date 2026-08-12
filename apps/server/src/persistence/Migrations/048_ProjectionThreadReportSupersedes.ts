import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Forward link only: a report names the earlier report it amends. The
  // reverse link ("who superseded me") is derived on read from this column,
  // so an amendment never rewrites the row it supersedes and the projection
  // stays append-only.
  yield* sql`
    ALTER TABLE projection_thread_reports
    ADD COLUMN supersedes_report_id TEXT
  `;

  // Every read path resolves the reverse link with a lookup by this column,
  // including full-table scans of the reports projection.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_reports_supersedes_report_id
    ON projection_thread_reports(supersedes_report_id)
  `;
});
