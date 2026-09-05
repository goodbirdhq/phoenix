import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep competing links so readers can report ambiguity rather than assign
  // copied/resumed native history to whichever Phoenix thread was seen last.
  yield* sql`
    CREATE TABLE usage_session_links (
      provider_name TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (provider_name, provider_instance_id, session_id, thread_id)
    )
  `;
  // Only existing explicit native cursors can backfill historical linkage.
  // Missing instance identity is deliberately not guessed from current login.
  yield* sql`
    INSERT INTO usage_session_links
    SELECT provider_name, provider_instance_id, native_id, thread_id, last_seen_at
    FROM (
      SELECT *, CASE
        WHEN provider_name = 'codex' THEN json_extract(resume_cursor_json, '$.threadId')
        WHEN provider_name = 'claudeAgent' THEN json_extract(resume_cursor_json, '$.resume')
        WHEN provider_name IN ('opencode', 'grok')
          AND json_extract(resume_cursor_json, '$.schemaVersion') = 1
          THEN json_extract(resume_cursor_json, '$.sessionId')
      END AS native_id
      FROM provider_session_runtime
      WHERE provider_instance_id IS NOT NULL AND json_valid(resume_cursor_json)
    )
    WHERE typeof(native_id) = 'text' AND length(native_id) > 0
  `;
});
