import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Adds durable Schedule definitions, Occurrences, commands, and events. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS schedule_definitions (
      schedule_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      state TEXT NOT NULL,
      next_occurrence_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_schedule_definitions_due
    ON schedule_definitions(state, next_occurrence_at, created_at, schedule_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS schedule_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      definition_json TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedule_definitions(schedule_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_pending
    ON schedule_occurrences(status, scheduled_for, schedule_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS schedule_commands (
      command_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS schedule_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_schedule_events_schedule
    ON schedule_events(schedule_id, sequence)
  `;
});
