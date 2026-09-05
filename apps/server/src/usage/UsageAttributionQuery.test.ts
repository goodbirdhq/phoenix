import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as Option from "effect/Option";
import { assert, it } from "@effect/vitest";
import { IsoDateTime, ProviderInstanceId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
import * as Query from "./UsageAttributionQuery.ts";

const layer = Layer.mergeAll(
  Runtime.layer,
  Query.layer,
  ProviderSessionDirectoryLive.pipe(Layer.provide(Runtime.layer)),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.layer(layer)("durable usage linkage", (it) => {
  it("retains native sessions across resets and returns their project metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* Runtime.ProviderSessionRuntimeRepository;
      const query = yield* Query.UsageAttributionQuery;
      // Use the actual projection schema and query, not a mocked join.
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, favicon_path) VALUES ('project', 'Phoenix', '/workspace', '[]', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '/icon.png')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES ('thread', 'project', 'Build Usage', '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`;
      const runtime: Runtime.ProviderSessionRuntime = {
        threadId: ThreadId.make("thread"),
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex-a"),
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: IsoDateTime.make("2026-09-01T00:00:00Z"),
        resumeCursor: { threadId: "native-a" },
        runtimePayload: null,
        usageSessionId: "native-a",
      };
      yield* repository.upsert(runtime);
      yield* repository.upsert(runtime);
      yield* repository.upsert({
        ...runtime,
        usageSessionId: "native-b",
        resumeCursor: { threadId: "native-b" },
      });
      yield* repository.deleteByThreadId({ threadId: runtime.threadId });
      const links = yield* query.list();
      assert.deepStrictEqual(links.map((link) => link.sessionId).sort(), ["native-a", "native-b"]);
      assert.strictEqual(links[0]?.thread.projectTitle, "Phoenix");
      assert.strictEqual(links[0]?.thread.projectFaviconPath, "/icon.png");
      assert.strictEqual(links[0]?.thread.createdAt, "2026-08-01T00:00:00Z");
    }));
  it("does not carry a native cursor into a different configured account", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* Runtime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("switch-account");
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-a"),
        resumeCursor: { threadId: "private-a" },
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-b"),
      });
      const row = yield* repository.getByThreadId({ threadId });
      assert.strictEqual(Option.getOrThrow(row).resumeCursor, null);
      const sql = yield* SqlClient.SqlClient;
      const links = yield* sql<{
        provider_instance_id: string;
      }>`SELECT provider_instance_id FROM usage_session_links WHERE thread_id = ${threadId}`;
      assert.deepStrictEqual(
        links.map((link) => link.provider_instance_id),
        ["codex-a"],
      );
    }));
  it("reports zero-usage threads from their actual creation time", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* Query.UsageAttributionQuery;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('zero-project', 'Zero', '/zero', '[]', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES ('zero-thread', 'zero-project', 'No tokens yet', '{"instanceId":"codex","model":"gpt"}', 'full-access', 'default', '2026-09-04T12:00:00Z', '2026-09-05T12:00:00Z')`;
      const creations = yield* query.creations("2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z");
      assert.deepStrictEqual(creations, [
        { threadId: "zero-thread", createdAt: "2026-09-04T12:00:00Z", instanceId: null },
      ]);
      assert.deepStrictEqual(
        yield* query.creations("2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z"),
        [],
      );
    }));
});
