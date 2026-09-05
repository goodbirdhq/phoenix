import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_sessions)`;
  if (!columns.some((column) => column.name === "episode_started_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN episode_started_at TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_active_delivery_state
    ON projection_turns(state, requested_at, row_id)
    WHERE pending_message_id IS NOT NULL
      AND state IN ('queued', 'interrupting', 'releasing')
  `;
});
