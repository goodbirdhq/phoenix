import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "073_UsageSessionLinksAcpProviders",
  (it) => {
    it.effect("backfills Cursor and Antigravity sessions and keeps existing links", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 72 });
        const rows = [
          ["cursor-thread", "cursor", { schemaVersion: 1, sessionId: "native-cursor" }],
          ["ag-thread", "antigravity", { schemaVersion: 1, sessionId: "native-ag" }],
          ["future", "cursor", { schemaVersion: 2, sessionId: "unsupported" }],
          ["codex-thread", "codex", { threadId: "native-codex" }],
        ] as const;
        for (const [id, provider, cursor] of rows) {
          yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at, resume_cursor_json) VALUES (${id}, ${provider}, ${provider}, ${provider}, 'stopped', '2026-09-01T00:00:00Z', ${encodeCursor(cursor)})`;
        }
        // A link already written at runtime must survive the backfill.
        yield* sql`INSERT INTO usage_session_links VALUES ('cursor', 'cursor', 'native-cursor', 'cursor-thread', '2026-09-02T00:00:00Z')`;
        yield* runMigrations({ toMigrationInclusive: 73 });
        const links = yield* sql<{
          provider_name: string;
          session_id: string;
          observed_at: string;
        }>`SELECT provider_name, session_id, observed_at FROM usage_session_links ORDER BY session_id`;
        assert.deepStrictEqual(
          links.map((link) => [link.provider_name, link.session_id, link.observed_at]),
          [
            ["antigravity", "native-ag", "2026-09-01T00:00:00Z"],
            ["cursor", "native-cursor", "2026-09-02T00:00:00Z"],
          ],
        );
      }),
    );
  },
);
