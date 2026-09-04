import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // When a spawned thread's newest send_to_parent message declared it is
  // blocked awaiting its parent's reply. Maintained by the projector from the
  // session-message.sent activity, cleared by the next turn start.
  if (!columns.some((column) => column.name === "awaiting_parent_reply_since")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN awaiting_parent_reply_since TEXT
    `;
  }
});
