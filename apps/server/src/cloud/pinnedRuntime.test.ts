import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";

const run = vi.fn(() => Effect.die("npm must not run"));
const unavailableRunner = ProcessRunner.ProcessRunner.of({ run });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("rejects a missing runtime without invoking npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "phoenix-pinned-runtime-test-" });
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: unavailableRunner,
        validate: () => Effect.void,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      if (error._tag === "PinnedRuntimeInstallError") {
        assert.match(error.step, /without a Phoenix-owned package distribution/);
      }
      assert.equal(run.mock.calls.length, 0);
    }),
  );

  it.effect("reuses and validates an already-complete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "phoenix-pinned-runtime-test-" });
      const paths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "export {};\n");
      yield* fs.writeFileString(paths.sentinelPath, "1.2.3\n");
      const validate = vi.fn(() => Effect.void);

      const reused = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner: unavailableRunner,
        validate,
      });

      assert.deepEqual(reused, paths);
      assert.equal(validate.mock.calls.length, 1);
      assert.equal(run.mock.calls.length, 0);
    }),
  );
});
