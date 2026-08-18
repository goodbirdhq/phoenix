// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type UsageDay,
  type UsageSummary,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

/**
 * Two signed-in Claude accounts, each with its own `CLAUDE_CONFIG_DIR`, plus a
 * Codex home — the shape of a machine that runs more than one subscription.
 */
const stateRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-usage-service-"));
const claudeAHome = NodePath.join(stateRoot, "claude-a");
const claudeBHome = NodePath.join(stateRoot, "claude-b");

function writeClaudeTranscript(home: string, sessionId: string, messageId: string): void {
  const dir = NodePath.join(home, "projects", "-tmp-project");
  NodeFS.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T12:00:00.000Z",
    sessionId,
    requestId: `req-${messageId}`,
    message: {
      id: messageId,
      model: "claude-fable-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  NodeFS.writeFileSync(NodePath.join(dir, `${sessionId}.jsonl`), `${line}\n`);
}

writeClaudeTranscript(claudeAHome, "session-a", "msg_a");
writeClaudeTranscript(claudeBHome, "session-b", "msg_b");

afterAll(() => {
  NodeFS.rmSync(stateRoot, { recursive: true, force: true });
});

/** Rates are fetched over the network; this suite is about which files get read. */
const offlineHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("usage tests do not fetch rates")),
);

const layerFor = (settings: Parameters<typeof serverSettingsLayerTest>[0]) =>
  UsageService.layer.pipe(
    Layer.provide(serverSettingsLayerTest(settings)),
    Layer.provide(offlineHttpClient),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const window = {
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-31" as UsageDay,
  timeZone: "UTC",
};

const claudeSources = (summary: UsageSummary) =>
  summary.sources.filter((source) => source.fingerprint.provider === "claude");

describe("UsageService transcript sources", () => {
  effectIt.effect("reads every configured Claude account, not just the default one", () =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage.readSummary(window);

      const homes = claudeSources(summary)
        .map((source) => source.fingerprint.resolvedHomePath)
        .toSorted();
      assert.deepEqual(homes, [
        NodePath.join(claudeAHome, "projects"),
        NodePath.join(claudeBHome, "projects"),
      ]);

      // Both accounts' tokens land, and each bucket says which home it came
      // from so a client can drop one shared home without dropping the other.
      const claudeBuckets = summary.buckets.filter((bucket) => bucket.provider === "claude");
      assert.equal(claudeBuckets.length, 2);
      assert.equal(
        claudeBuckets.reduce((total, bucket) => total + bucket.totals.outputTokens, 0),
        100,
      );
      assert.equal(new Set(claudeBuckets.map((bucket) => bucket.sourceId)).size, 2);

      // Every bucket's source id resolves to a source row in the same summary.
      const sourceIds = new Set(summary.sources.map((source) => source.id));
      assert.isTrue(summary.buckets.every((bucket) => sourceIds.has(bucket.sourceId)));
    }).pipe(
      Effect.provide(
        layerFor({
          providers: { claudeAgent: { homePath: claudeAHome } },
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent_claude_b")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeBHome },
            },
          },
        }),
      ),
    ),
  );

  effectIt.effect("scans a home shared by two instances once", () =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage.readSummary(window);

      assert.equal(claudeSources(summary).length, 1);
      const claudeBuckets = summary.buckets.filter((bucket) => bucket.provider === "claude");
      assert.equal(claudeBuckets.length, 1);
      assert.equal(claudeBuckets[0]?.totals.outputTokens, 50);
    }).pipe(
      Effect.provide(
        layerFor({
          providers: { claudeAgent: { homePath: claudeAHome } },
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent_duplicate")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeAHome },
            },
          },
        }),
      ),
    ),
  );
});
