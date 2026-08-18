// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterAll, assert, describe } from "vite-plus/test";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { readWorkflowScript } from "./workflowScriptQuery.ts";

const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_script_test__");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(NodeOS.tmpdir(), "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
// A second signed-in Claude account keeps its scripts under its own
// CLAUDE_CONFIG_DIR, which is a home the default settings know nothing about.
const secondHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-claude-b-"));
const secondRoot = NodePath.join(secondHome, "projects", "__wf_script_test__");
NodeFS.mkdirSync(secondRoot, { recursive: true });
const secondScriptPath = NodePath.join(secondRoot, "run.js");
NodeFS.writeFileSync(secondScriptPath, "export const meta = { name: 'b' };\n");
const link = NodePath.join(root, "sneaky.js");
try {
  NodeFS.symlinkSync(outside, link);
} catch (error) {
  // Tolerate only "already exists" from a prior run — any other failure
  // (EPERM etc.) must fail setup, or the escape test below would pass
  // vacuously on "not-found" without testing containment.
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }
}
if (!NodeFS.lstatSync(link).isSymbolicLink()) {
  throw new Error("test setup: sneaky.js must be a symlink");
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
  NodeFS.rmSync(secondHome, { recursive: true, force: true });
});

/** Only the default Claude instance is configured. */
const defaultInstance = Layer.provideMerge(serverSettingsLayerTest(), Path.layer);

/** A second Claude account, with its own home, alongside the default one. */
const twoInstances = Layer.provideMerge(
  serverSettingsLayerTest({
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent_b")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: secondHome },
      },
    },
  }),
  Path.layer,
);

describe("readWorkflowScript containment", () => {
  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }).pipe(Effect.provide(defaultInstance)),
  );

  effectIt.effect("rejects relative and non-js paths", () =>
    Effect.gen(function* () {
      const relative = yield* Effect.exit(readWorkflowScript({ scriptPath: "run.js" }));
      assert.equal(relative._tag, "Failure");
      const nonJs = yield* Effect.exit(
        readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts") }),
      );
      assert.equal(nonJs._tag, "Failure");
    }).pipe(Effect.provide(defaultInstance)),
  );

  effectIt.effect("rejects paths outside the root and symlink escapes", () =>
    Effect.gen(function* () {
      const escaped = yield* Effect.exit(readWorkflowScript({ scriptPath: outside }));
      assert.equal(escaped._tag, "Failure");
      // A symlink INSIDE the root pointing outside must fail specifically on
      // realpath re-containment — a "not-found" would mean the link was
      // never exercised and the assertion proves nothing.
      const sneaky = yield* Effect.exit(
        readWorkflowScript({ scriptPath: link }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      );
      assert.equal(sneaky._tag, "Success");
      if (sneaky._tag === "Success") {
        assert.equal(sneaky.value, "outside-root");
      }
    }).pipe(Effect.provide(defaultInstance)),
  );

  effectIt.effect("serves a script under a second Claude instance's home", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath: secondScriptPath });
      assert.include(result.contents, "name: 'b'");
    }).pipe(Effect.provide(twoInstances)),
  );

  effectIt.effect("keeps a home no instance is configured with out of reach", () =>
    Effect.gen(function* () {
      // Same file, same containment code — the only difference is that this
      // server has no instance rooted at that home.
      const reason = yield* readWorkflowScript({ scriptPath: secondScriptPath }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      assert.equal(reason, "outside-root");
    }).pipe(Effect.provide(defaultInstance)),
  );
});
