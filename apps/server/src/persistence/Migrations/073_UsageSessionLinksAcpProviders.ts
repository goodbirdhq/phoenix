import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // 061 backfilled only the providers usage attribution covered then. Cursor and
  // Antigravity links are otherwise written only when a binding is next upserted,
  // so their historical threads would never attribute.
  yield* sql`
    INSERT OR IGNORE INTO usage_session_links
    SELECT provider_name, provider_instance_id, native_id, thread_id, last_seen_at
    FROM (
      SELECT *, json_extract(resume_cursor_json, '$.sessionId') AS native_id
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'antigravity')
        AND provider_instance_id IS NOT NULL
        AND json_valid(resume_cursor_json)
        AND json_extract(resume_cursor_json, '$.schemaVersion') = 1
    )
    WHERE typeof(native_id) = 'text' AND length(native_id) > 0
  `;
});
