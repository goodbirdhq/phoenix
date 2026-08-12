import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Queue rows used to be deleted when released or cancelled. Retain their
  // terminal receipt instead, while leaving the concrete turn lifecycle row
  // untouched.
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN consumed_by_turn_id TEXT
  `;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN releasing_at TEXT
  `;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN consumed_at TEXT
  `;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN cancelled_at TEXT
  `;
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN cancel_reason TEXT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_receipts_thread_recent
    ON projection_turns(
      thread_id,
      COALESCE(cancelled_at, consumed_at, requested_at) DESC,
      row_id DESC
    )
  `;
});
