// @effect-diagnostics nodeBuiltinImport:off - stages fake packages on disk for a require-based loader
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, it } from "@effect/vitest";

import { loadFffNode } from "./loadFffNode.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

// A fake @ff-labs/fff-node install whose entry module reports which path
// loaded it. `exports` decides whether a bare `require` is allowed.
function stageFakeFffNode(input: { readonly exports: Record<string, string> }) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "load-fff-node-"));
  tempDirs.push(root);
  const packageDir = NodePath.join(root, "node_modules", "@ff-labs", "fff-node");
  NodeFS.mkdirSync(NodePath.join(packageDir, "dist", "src"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@ff-labs/fff-node",
      version: "0.0.0-test",
      type: "module",
      main: "dist/src/index.js",
      exports: { ".": input.exports },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "dist", "src", "index.js"),
    "export const FileFinder = { loadedFrom: import.meta.url };\n",
  );
  const entryPath = NodePath.join(root, "entry.mjs");
  NodeFS.writeFileSync(entryPath, "");
  return { requireFn: NodeModule.createRequire(entryPath), packageDir };
}

it("falls back to the entry file when the exports map has no require condition", () => {
  // The shape npm consumers get: the pnpm patch that adds `require` is absent.
  const { requireFn, packageDir } = stageFakeFffNode({
    exports: { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
  });

  const loaded = loadFffNode(requireFn) as unknown as { FileFinder: { loadedFrom: string } };

  assert.strictEqual(
    loaded.FileFinder.loadedFrom,
    new URL(`file://${NodePath.join(packageDir, "dist", "src", "index.js")}`).href,
  );
});

it("uses the bare require when the exports map allows it", () => {
  const { requireFn, packageDir } = stageFakeFffNode({
    exports: { import: "./dist/src/index.js", require: "./dist/src/index.js" },
  });

  const loaded = loadFffNode(requireFn) as unknown as { FileFinder: { loadedFrom: string } };

  assert.strictEqual(
    loaded.FileFinder.loadedFrom,
    new URL(`file://${NodePath.join(packageDir, "dist", "src", "index.js")}`).href,
  );
});

it("rethrows when the package is missing altogether", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "load-fff-node-missing-"));
  tempDirs.push(root);
  const entryPath = NodePath.join(root, "entry.mjs");
  NodeFS.writeFileSync(entryPath, "");

  let caught: unknown;
  try {
    loadFffNode(NodeModule.createRequire(entryPath));
  } catch (error) {
    caught = error;
  }

  assert.strictEqual((caught as { code?: string } | undefined)?.code, "MODULE_NOT_FOUND");
});
