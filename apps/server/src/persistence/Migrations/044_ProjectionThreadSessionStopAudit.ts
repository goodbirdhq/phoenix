import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "stopped_by")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN stopped_by TEXT`;
  }
  if (!columns.some((column) => column.name === "stop_requested_at")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN stop_requested_at TEXT`;
  }
  if (!columns.some((column) => column.name === "stop_reason")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN stop_reason TEXT`;
  }
  if (!columns.some((column) => column.name === "interrupted_tool_call")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN interrupted_tool_call INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!columns.some((column) => column.name === "last_completed_operation")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN last_completed_operation TEXT`;
  }
  if (!columns.some((column) => column.name === "grace_stop_deadline_at")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN grace_stop_deadline_at TEXT`;
  }
  if (!columns.some((column) => column.name === "grace_stop_episode_id")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN grace_stop_episode_id TEXT`;
  }
});
