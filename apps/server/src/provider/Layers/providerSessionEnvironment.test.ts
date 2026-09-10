import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CursorSettings, GrokSettings, OpenCodeSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const cursorSettings = Schema.decodeSync(CursorSettings)({});
const grokSettings = Schema.decodeSync(GrokSettings)({});
const openCodeSettings = Schema.decodeSync(OpenCodeSettings)({});

for (const provider of ["codex", "cursor", "grok", "opencode"] as const) {
  it.effect(`${provider} reserves T3_THREAD_ID at process launch for concurrent sessions`, () => {
    const environment = {
      T3_THREAD_ID: "caller-override",
      CUSTOM: "kept",
      HOME: "/tmp/account",
      CODEX_HOME: "/tmp/original-codex",
      GROK_HOME: "/tmp/grok-account",
      XDG_CONFIG_HOME: "/tmp/config-account",
    };
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      NodeAssert.equal(command._tag, "StandardCommand");
      if (command._tag === "StandardCommand") environments.push(command.options.env);
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "test launch boundary",
        }),
      );
    });
    return Effect.gen(function* () {
      const options = { environment };
      const adapter =
        provider === "cursor"
          ? yield* makeCursorAdapter(cursorSettings, options)
          : provider === "grok"
            ? yield* makeGrokAdapter(grokSettings, options)
            : provider === "opencode"
              ? yield* makeOpenCodeAdapter(openCodeSettings, options)
              : undefined;
      const results = yield* Effect.forEach(
        ["phoenix-one", "phoenix-two"],
        (id) => {
          const input = {
            threadId: ThreadId.make(id),
            cwd: "/tmp",
            runtimeMode: "full-access" as const,
          };
          return Effect.gen(function* () {
            if (provider === "codex") {
              yield* makeCodexSessionRuntime({
                ...input,
                environment,
                binaryPath: "codex",
                homePath: "/tmp/codex-account",
              });
            } else {
              NodeAssert.ok(adapter);
              yield* adapter.startSession(input);
            }
          }).pipe(Effect.exit);
        },
        { concurrency: "unbounded" },
      );
      NodeAssert.ok(results.every(Exit.isFailure));
      NodeAssert.deepEqual(environments.map((env) => env?.T3_THREAD_ID).sort(), [
        "phoenix-one",
        "phoenix-two",
      ]);
      for (const env of environments) {
        NodeAssert.equal(env?.CUSTOM, "kept");
        NodeAssert.equal(env?.HOME, environment.HOME);
        NodeAssert.equal(env?.GROK_HOME, environment.GROK_HOME);
        NodeAssert.equal(env?.XDG_CONFIG_HOME, environment.XDG_CONFIG_HOME);
        NodeAssert.equal(
          env?.CODEX_HOME,
          provider === "codex" ? "/tmp/codex-account" : environment.CODEX_HOME,
        );
      }
      NodeAssert.equal(environment.T3_THREAD_ID, "caller-override");
    }).pipe(
      Effect.provide(
        OpenCodeRuntimeLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerConfig.layerTest("/tmp", "/tmp").pipe(Layer.provideMerge(NodeServices.layer)),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        ),
      ),
      Effect.scoped,
    );
  });
}
