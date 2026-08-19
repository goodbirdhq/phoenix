import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Normalizes Schedule history and upgrades legacy Schedule events for replay. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE schedule_commands ADD COLUMN command_json TEXT`;
  yield* sql`
    ALTER TABLE schedule_events
    ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1
  `;
  yield* sql`
    UPDATE schedule_commands
    SET command_json = (
      SELECT CASE
        WHEN json_type(schedule_events.payload_json, '$.command') = 'object'
          THEN json_extract(schedule_events.payload_json, '$.command')
        WHEN schedule_events.event_type = 'schedule.occurrence-reserved'
          AND json_extract(schedule_events.payload_json, '$.source') = 'manual'
          THEN json_object(
            'type', 'schedule.run-now',
            'commandId', schedule_commands.command_id,
            'scheduleId', schedule_commands.schedule_id,
            'occurrenceId', json_extract(schedule_events.payload_json, '$.occurrenceId')
          )
        ELSE schedule_events.payload_json
      END
      FROM schedule_events
      WHERE schedule_events.sequence = schedule_commands.result_sequence
    )
    WHERE command_json IS NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS schedule_history (
      history_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      failure_code TEXT,
      failure_message TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES schedule_definitions(schedule_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_schedule_history_page
    ON schedule_history(schedule_id, history_sequence DESC)
  `;
  yield* sql`
    INSERT INTO schedule_history (
      schedule_id, kind, failure_code, failure_message, record_json, created_at
    )
    SELECT
      definitions.schedule_id,
      json_extract(history.value, '$.type'),
      json_extract(history.value, '$.code'),
      json_extract(history.value, '$.message'),
      history.value,
      COALESCE(
        json_extract(history.value, '$.triggeredAt'),
        json_extract(history.value, '$.failedAt'),
        json_extract(history.value, '$.recordedAt'),
        definitions.updated_at
      )
    FROM schedule_definitions AS definitions,
      json_each(definitions.record_json, '$.history') AS history
    ORDER BY definitions.created_at, definitions.schedule_id, history.key
  `;

  yield* sql`
    UPDATE schedule_definitions
    SET record_json = json_remove(record_json, '$.history', '$.historyNextCursor')
  `;
  yield* sql`
    UPDATE schedule_occurrences
    SET definition_json = json_remove(definition_json, '$.history', '$.historyNextCursor')
  `;

  // v51 events predate the replayable domain-event shape and do not contain
  // enough transition data to reconstruct every intermediate definition.
  // Preserve each Schedule's final sequence while compacting its legacy stream
  // to one authoritative definition snapshot. Deleted Schedules retain their
  // final deletion event, with its raw v51 command wrapped in the v2 shape.
  yield* sql`
    DELETE FROM schedule_events
    WHERE sequence NOT IN (
      SELECT MAX(sequence) FROM schedule_events GROUP BY schedule_id
    )
  `;
  yield* sql`
    UPDATE schedule_events
    SET event_type = 'schedule.rebased',
      payload_json = (
        SELECT json_object(
          'type', 'schedule.rebased',
          'definition', json(definitions.record_json)
        )
        FROM schedule_definitions AS definitions
        WHERE definitions.schedule_id = schedule_events.schedule_id
      ),
      payload_version = 2
    WHERE EXISTS (
      SELECT 1 FROM schedule_definitions AS definitions
      WHERE definitions.schedule_id = schedule_events.schedule_id
    )
  `;
  yield* sql`
    UPDATE schedule_events
    SET payload_json = CASE
        WHEN json_extract(payload_json, '$.type') = 'schedule.delete'
          THEN json_object(
            'type', 'schedule.deleted',
            'command', json(payload_json)
          )
        ELSE payload_json
      END,
      payload_version = 2
    WHERE event_type = 'schedule.deleted'
  `;
});
