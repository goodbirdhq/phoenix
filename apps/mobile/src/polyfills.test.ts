import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("restores array APIs before rendering a saved thread on older Hermes runtimes", () => {
  const result = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from 'node:assert/strict';
        delete Array.prototype.toSorted;
        delete Array.prototype.toReversed;
        await import('./polyfills.ts');
        const { usageLimitMigrationEpisodeKey } = await import(
          '../../../packages/client-runtime/src/usage/threadMigration.ts'
        );
        const source = Object.freeze([3, 1, 2]);
        assert.deepEqual(source.toSorted((a, b) => a - b), [1, 2, 3]);
        assert.deepEqual(source.toReversed(), [2, 1, 3]);
        assert.deepEqual(source, [3, 1, 2]);
        assert.equal(usageLimitMigrationEpisodeKey({
          threadId: 'saved-thread',
          boundInstanceId: 'codex',
          boundInstanceAvailability: undefined,
          boundModel: 'gpt-5.4',
        }), ['saved-thread', 'codex', 'unknown'].join(String.fromCharCode(0)));
        console.log('startup compatibility passed');
      `,
    ],
    { cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
  );
  expect(result.trim()).toBe("startup compatibility passed");
});
