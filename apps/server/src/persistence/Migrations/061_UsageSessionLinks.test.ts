import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeSqliteClient.layerMemory())("061_UsageSessionLinks", (it) => {
  it.effect(
    "backfills explicit supported native identities, excluding malformed and unidentified rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        const rows = [
          ["codex", "codex", { threadId: "native-codex" }],
          ["claude", "claudeAgent", { threadId: "phoenix", resume: "native-claude" }],
          ["grok", "grok", { schemaVersion: 1, sessionId: "native-grok" }],
          ["opencode", "opencode", { schemaVersion: 1, sessionId: "native-opencode" }],
          ["unknown", "claudeAgent", { threadId: "phoenix" }],
          ["future", "grok", { schemaVersion: 2, sessionId: "unsupported" }],
        ] as const;
        for (const [id, provider, cursor] of rows) {
          yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at, resume_cursor_json) VALUES (${id}, ${provider}, ${provider}, ${provider}, 'running', '2026-09-01T00:00:00Z', ${encodeCursor(cursor)})`;
        }
        yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at, resume_cursor_json) VALUES ('invalid', 'codex', 'codex', 'codex', 'running', '2026-09-01T00:00:00Z', '{invalid')`;
        yield* runMigrations({ toMigrationInclusive: 61 });
        const links = yield* sql<{
          session_id: string;
        }>`SELECT session_id FROM usage_session_links ORDER BY session_id`;
        assert.deepStrictEqual(
          links.map((link) => link.session_id),
          ["native-claude", "native-codex", "native-grok", "native-opencode"],
        );
      }),
  );
});
