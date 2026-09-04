import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  // Who authored a user-role message when it was not the human: another
  // agent session (send_to_parent/send_to_session, report deliveries) or
  // Phoenix itself (death notices, wedge alarms). Null = the human.
  if (!columns.some((column) => column.name === "origin_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN origin_json TEXT
    `;
  }
});
