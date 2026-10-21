import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["phoenix"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "phoenix-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "phoenix-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Phoenix runs alongside upstream T3 Code, so adopting any of its profiles would point
// two live applications at one directory.
it.effect.each([
  { isDevelopment: false, platform: "win32", expected: "phoenix-v2" },
  { isDevelopment: false, platform: "linux", expected: "phoenix-v2" },
  { isDevelopment: true, platform: "win32", expected: "phoenix-dev" },
] as const)(
  "never adopts T3 Code profiles ($platform, dev: $isDevelopment)",
  ({ isDevelopment, platform, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "phoenix-profile-" });
      for (const name of [
        "t3code",
        "t3code-v2",
        "t3code-dev",
        "T3 Code (Alpha)",
        "T3 Code (Dev)",
      ]) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "T3 Code state");
      }
      const resolved = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform,
      });
      assert.equal(resolved, path.join(directory, expected));
      assert.isFalse(yield* fs.exists(path.join(resolved, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
