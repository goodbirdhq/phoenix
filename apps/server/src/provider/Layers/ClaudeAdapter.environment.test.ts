// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ClaudeSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.testFixtures.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const claudeSettings = Schema.decodeSync(ClaudeSettings)({ homePath: "/tmp/claude-account" });

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("test launch boundary");
  }),
}));

it.effect("reserves T3_THREAD_ID at the Claude SDK process launch for concurrent sessions", () => {
  const environment = { T3_THREAD_ID: "caller-override", CUSTOM: "kept", HOME: "/tmp/account" };
  const queryEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
  vi.mocked(NodeChildProcess.spawn).mockClear();
  vi.mocked(query).mockImplementation(({ options }) => {
    queryEnvironments.push(options?.env);
    options!.spawnClaudeCodeProcess!({
      command: "claude",
      args: [],
      cwd: "/tmp",
      env: { ...options?.env, T3_THREAD_ID: "sdk-override", SDK_CUSTOM: "sdk-kept" },
      signal: new AbortController().signal,
    });
    throw new Error("fake spawn must stop at the launch boundary");
  });
  return Effect.gen(function* () {
    const adapter = yield* makeClaudeAdapter(claudeSettings, {
      environment,
      modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    });
    const results = yield* Effect.forEach(
      ["phoenix-one", "phoenix-two"],
      (id) =>
        Effect.exit(
          adapter.startSession({ threadId: ThreadId.make(id), runtimeMode: "full-access" }),
        ),
      { concurrency: "unbounded" },
    );
    assert.isTrue(results.every(Exit.isFailure));
    assert.deepEqual(queryEnvironments.map((env) => env?.T3_THREAD_ID).sort(), [
      "phoenix-one",
      "phoenix-two",
    ]);
    const environments = vi.mocked(NodeChildProcess.spawn).mock.calls.map((call) => call[2]?.env);
    assert.deepEqual(environments.map((env) => env?.T3_THREAD_ID).sort(), [
      "phoenix-one",
      "phoenix-two",
    ]);
    for (const env of environments) {
      assert.equal(env?.CUSTOM, "kept");
      assert.equal(env?.SDK_CUSTOM, "sdk-kept");
      assert.equal(env?.HOME, "/tmp/account");
      assert.equal(env?.CLAUDE_CONFIG_DIR, "/tmp/claude-account");
    }
    assert.equal(environment.T3_THREAD_ID, "caller-override");
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest("/tmp", "/tmp").pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  );
});
