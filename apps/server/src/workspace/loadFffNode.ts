// @effect-diagnostics nodeBuiltinImport:off - runs at module load, before any Effect runtime
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type FffNodeModule = typeof import("@ff-labs/fff-node");

const FFF_PACKAGE_NAME = "@ff-labs/fff-node";

/**
 * Loads fff-node through `require`, which is the only loader that works inside
 * a Node single-executable and reads from the real filesystem everywhere else.
 *
 * fff-node publishes an ESM-only `exports` map: an `import` condition and no
 * `require` one. The repo's pnpm patch adds `require`, so every pnpm-staged
 * tree (dev, desktop, CLI archive) requires it fine. An npm install of the
 * published package never sees that patch, so the bare require fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED and `npx @goodbirdhq/phoenix` and remote
 * service updates die at load. When that happens, require the package's entry
 * file by path instead: `require(esm)` is unflagged on every Node in `engines`.
 */
export function loadFffNode(
  requireFn: NodeJS.Require = NodeModule.createRequire(import.meta.url),
): FffNodeModule {
  try {
    return requireFn(FFF_PACKAGE_NAME) as FffNodeModule;
  } catch (error) {
    if (!isPackagePathNotExported(error)) throw error;
    const entryPath = resolveFffEntryPath(requireFn);
    if (entryPath === undefined) throw error;
    return requireFn(entryPath) as FffNodeModule;
  }
}

function isPackagePathNotExported(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
}

// `require.resolve` honours `exports` too, so it cannot reach package.json
// here. Walk the resolver's node_modules candidates by hand instead.
function resolveFffEntryPath(requireFn: NodeJS.Require): string | undefined {
  for (const candidateDir of requireFn.resolve.paths(FFF_PACKAGE_NAME) ?? []) {
    const packageDir = NodePath.join(candidateDir, FFF_PACKAGE_NAME);
    const manifestPath = NodePath.join(packageDir, "package.json");
    if (!NodeFS.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly main?: unknown;
    };
    const main = typeof manifest.main === "string" ? manifest.main : "dist/src/index.js";
    return NodePath.join(packageDir, main);
  }
  return undefined;
}
