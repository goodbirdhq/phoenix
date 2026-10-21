import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.phoenix/dev");
      assert.equal(production.stateDir, "/Users/alice/.phoenix/userdata");
    }),
  );

  // A T3CODE_HOME set for upstream T3 Code must never move Phoenix into its database.
  it.effect("reads PHOENIX_HOME and ignores T3CODE_HOME", () =>
    Effect.gen(function* () {
      const upstreamOnly = yield* makeEnvironment({}, { T3CODE_HOME: "/Users/alice/.t3" });
      const both = yield* makeEnvironment(
        {},
        { T3CODE_HOME: "/Users/alice/.t3", PHOENIX_HOME: "/Users/alice/phoenix-home" },
      );

      assert.equal(upstreamOnly.baseDir, "/Users/alice/.phoenix");
      assert.equal(both.baseDir, "/Users/alice/phoenix-home");
    }),
  );

  it.effect("prefers PHOENIX_ variables and falls back to their T3CODE_ names", () =>
    Effect.gen(function* () {
      const upstream = yield* makeEnvironment({}, { T3CODE_PORT: "4100" });
      const both = yield* makeEnvironment({}, { T3CODE_PORT: "4100", PHOENIX_PORT: "4200" });

      assert.deepEqual(upstream.configuredBackendPort, Option.some(4100));
      assert.deepEqual(both.configuredBackendPort, Option.some(4200));
    }),
  );

  it.effect("registers Phoenix identities with the OS", () =>
    Effect.gen(function* () {
      const production = yield* makeEnvironment();
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.equal(production.displayName, "Phoenix (Alpha)");
      assert.equal(production.appUserModelId, "com.goodbird.phoenix");
      assert.equal(production.linuxDesktopEntryName, "phoenix.desktop");
      assert.equal(production.linuxWmClass, "phoenix");
      assert.equal(development.appUserModelId, "com.goodbird.phoenix.dev");
      assert.equal(development.linuxDesktopEntryName, "phoenix-dev.desktop");
    }),
  );
});
