import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX idx_projection_threads_created_at
    ON projection_threads(created_at, thread_id)
  `;
  yield* sql`
    CREATE INDEX idx_orch_events_thread_created
    ON orchestration_events(stream_id, sequence)
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.created'
  `;
});
