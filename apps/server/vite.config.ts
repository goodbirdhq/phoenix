// @effect-diagnostics nodeBuiltinImport:off - Build-time git lookup; runs in the
// bundler config before any Effect runtime exists.
import "vite-plus/test/config";
import * as NodeChildProcess from "node:child_process";

import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import packageJson from "./package.json" with { type: "json" };

// The bundle used to inline only workspace packages, leaving every third-party
// runtime dep external. External deps must exist on the real filesystem (the WSL
// backend runs plain `wsl.exe -- node`, which cannot read inside an asar), so the
// desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to
// support 20 native binaries. NSIS install time tracks file count, not bytes.
//
// Inverted here — bundle everything except the packages that genuinely cannot be
// inlined. See scripts/lib/cli-external-packages.ts for what earns an exemption.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";

// `build:exe` (T3CODE_PACK_EXE=1) wraps the same bundle in a Node
// single-executable (dist-exe/phoenix) for scripts/build-cli-archive.ts.
// tsdown's exe step refuses multi-chunk output and counts the sourcemap as a
// chunk, so this is a separate mode. It embeds the Node that runs the build:
// vp downloads VP_NODE_VERSION from nodejs.org when set, which release.yml
// pins; it must support `--build-sea` (25.7+).
const packExecutable = process.env.T3CODE_PACK_EXE === "1";

// The revision this bundle was built from, so `phoenix --version` can name the
// commit an install is actually running. CI passes it explicitly; a local build
// reads git directly and marks an uncommitted tree, because a dirty build is
// exactly the case where the version number alone tells you nothing. Resolves
// to "" wherever git cannot answer (published tarball, checkout with no .git),
// which `--version` reports as unknown rather than inventing a commit.
const resolveCliBuildCommit = (): string => {
  const fromEnv = (process.env.T3CODE_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? "").trim();
  if (fromEnv !== "") return fromEnv.slice(0, 8);
  const git = (args: ReadonlyArray<string>): string =>
    NodeChildProcess.execFileSync("git", [...args], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const sha = git(["rev-parse", "--short=8", "HEAD"]);
    if (sha === "") return "";
    return git(["status", "--porcelain"]) === "" ? sha : `${sha}-dirty`;
  } catch {
    return "";
  }
};

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      // The executable embeds one entry; the history worker becomes a hidden
      // subcommand there instead of a sibling script.
      entry: packExecutable ? ["src/bin.ts"] : ["src/bin.ts", "src/claude-history-worker.ts"],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      clean: true,
      ...(packExecutable
        ? {
            exe: {
              fileName: "phoenix",
              outDir: "dist-exe",
              // `import()` does not work in a SEA when useCodeCache is true.
              seaConfig: { useCodeCache: false },
            },
          }
        : {}),
      deps: {
        // Both halves are required. `alwaysBundle` forces the JS dependencies in
        // (declared deps are external by default, which is what this change is
        // undoing). `neverBundle` forces the native packages out: returning
        // false from `alwaysBundle` only means "no opinion", so a transitive
        // dependency would still be bundled — which silently inlined native
        // loaders such as node-gyp-build, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_COMMIT__: JSON.stringify(resolveCliBuildCommit()),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
