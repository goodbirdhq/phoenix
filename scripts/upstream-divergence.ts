#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";

export type Owner = "upstream" | "phoenix";

// Source of truth for the ownership map in docs/internals/divergence.md. Upstream owns every path
// that does not start with one of these prefixes.
export const PHOENIX_OWNED: ReadonlyArray<string> = [
  "apps/web/src/components/Sidebar",
  "apps/web/src/components/sidebar/",
  "apps/web/src/components/AppSidebarLayout.tsx",
  "apps/web/src/components/threadSidebarWidth.ts",
  "apps/web/src/branding",
  "apps/web/public/",
  "apps/mobile/src/features/threads/thread-list-v2",
  "apps/mobile/src/features/threads/threadListV2",
  "apps/mobile/src/features/threads/thread-row-",
  "apps/mobile/src/features/threads/thread-avatar-status",
  "apps/mobile/src/features/threads/ThreadAgentGroup.tsx",
  "apps/mobile/src/components/ThreadAvatar.tsx",
  "apps/mobile/src/lib/pressFeedback",
  "apps/mobile/assets/",
  "apps/desktop/resources/",
  "assets/",
  "packages/shared/src/themePalettes.ts",
  ".github/ISSUE_TEMPLATE/",
  ".github/SECURITY.md",
  "docs/internals/branding.md",
  "docs/internals/divergence.md",
  "docs/operations/upstream-integration",
  "scripts/upstream-divergence",
];

export const ownerOf = (path: string): Owner =>
  PHOENIX_OWNED.some((prefix) => path.startsWith(prefix)) ? "phoenix" : "upstream";

/** Backticked paths in the Where column of the register table. */
export const registeredPaths = (markdown: string): ReadonlyArray<string> => {
  const rows = (markdown.split(/^## Register$/m)[1] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const where = rows[0]?.indexOf("Where") ?? -1;
  if (where < 0) return [];
  return rows
    .slice(2)
    .flatMap((cells) => [...(cells[where] ?? "").matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!))
    .filter((token) => /[./]/.test(token));
};

// A registered file also covers its tests: `Foo.ts` covers `Foo.test.ts`. A trailing `/` is a
// directory.
export const isCovered = (path: string, registered: ReadonlyArray<string>): boolean =>
  registered.some((entry) =>
    entry.endsWith("/")
      ? path.startsWith(entry)
      : path === entry || path.startsWith(`${entry.replace(/\.[^./]+$/, "")}.`),
  );

// Rename-only lines are the identity row in branding.md, which would otherwise flag hundreds of
// files. A file counts when every changed line names a brand, port, or home.
const IDENTITY = /phoenix|goodbird|t3|3[78]73|5[78]33/i;

/** Files whose every changed line is an identity rename, from `git diff -U0` output. */
export const identityOnlyFiles = (diff: string): ReadonlySet<string> => {
  const changes = new Map<string, { total: number; identity: number }>();
  let current: { total: number; identity: number } | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { total: 0, identity: 0 };
      changes.set(line.slice(line.indexOf(" b/") + 3), current);
    } else if (current && /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) {
      current.total += 1;
      if (IDENTITY.test(line)) current.identity += 1;
    }
  }
  return new Set(
    [...changes].filter(([, c]) => c.total > 0 && c.total === c.identity).map(([path]) => path),
  );
};

export class NoUpstreamDifferenceError extends Schema.TaggedError<NoUpstreamDifferenceError>()(
  "NoUpstreamDifferenceError",
  { ref: Schema.String },
) {
  override get message() {
    return `No differences from ${this.ref}; is the ref fetched?`;
  }
}

export interface DivergenceReport {
  readonly phoenix: ReadonlyArray<string>;
  readonly registered: ReadonlyArray<string>;
  readonly identityOnly: ReadonlyArray<string>;
  readonly unregistered: ReadonlyArray<string>;
}

export const groupDivergence = (input: {
  readonly files: ReadonlyArray<string>;
  readonly identityOnly: ReadonlySet<string>;
  readonly registered: ReadonlyArray<string>;
}): DivergenceReport => {
  const report = { phoenix: [], registered: [], identityOnly: [], unregistered: [] } as {
    [K in keyof DivergenceReport]: Array<string>;
  };
  for (const path of [...input.files].sort()) {
    if (ownerOf(path) === "phoenix") report.phoenix.push(path);
    else if (isCovered(path, input.registered)) report.registered.push(path);
    else if (input.identityOnly.has(path)) report.identityOnly.push(path);
    else report.unregistered.push(path);
  }
  return report;
};

const git = Effect.fn("upstreamDivergence.git")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make("git", [...args], { stdin: "ignore" }));
});

const run = Effect.fn("upstreamDivergence.run")(function* (ref: string) {
  const fs = yield* FileSystem.FileSystem;
  const range = `${ref}...HEAD`;
  const files = (yield* git(["diff", "--name-only", "--no-renames", range]))
    .split("\n")
    .filter((line) => line.length > 0);
  if (files.length === 0) {
    return yield* new NoUpstreamDifferenceError({ ref });
  }
  const report = groupDivergence({
    files,
    identityOnly: identityOnlyFiles(yield* git(["diff", "-U0", "--no-renames", range])),
    registered: registeredPaths(
      yield* fs.readFileString(`${import.meta.dirname}/../docs/internals/divergence.md`),
    ),
  });
  yield* Console.log(`${files.length} files differ from ${ref} since the merge base.`);
  yield* Console.log(`  phoenix-owned:              ${report.phoenix.length}`);
  yield* Console.log(`  upstream-owned, registered: ${report.registered.length}`);
  yield* Console.log(`  upstream-owned, rename-only identity: ${report.identityOnly.length}`);
  yield* Console.log(`\nUnregistered engine divergence (${report.unregistered.length}):`);
  for (const path of report.unregistered) yield* Console.log(`  ${path}`);
});

const upstreamDivergenceCommand = Command.make(
  "upstream-divergence",
  {
    ref: Argument.String("upstream-ref").pipe(
      Argument.withDescription("Upstream ref to compare against."),
      Argument.withDefault("upstream/main"),
    ),
  },
  ({ ref }) => run(ref),
).pipe(Command.withDescription("Group files that differ from upstream by owner."));

if (import.meta.main) {
  Command.run(upstreamDivergenceCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
