import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The release marker must outlive the synthetic starting session so the
  // provider's later running update can attribute the consumed message.
  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN queued_delivery_message_id TEXT
  `;
  // Bound stale-release retries across reactor and process restarts.
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN redelivery_count INTEGER NOT NULL DEFAULT 0
  `;
});
