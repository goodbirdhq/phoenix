import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every report that predates synthesized terminal reports was posted by an
  // agent calling post_report, so the column default backfills existing rows
  // correctly without a separate UPDATE.
  yield* sql`
    ALTER TABLE projection_thread_reports
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'
  `;
});
