// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules (lifted from the reviewed #3650 inspection service):
 * - the resolved realpath must live under the projects directory of one of
 *   the configured Claude instances (where the Claude harness persists
 *   workflow scripts) — realpath re-containment defeats symlink escapes,
 *   including a symlinked leaf file. Every instance counts: a machine with a
 *   second signed-in account keeps its scripts under that account's
 *   `CLAUDE_CONFIG_DIR`, and those scripts are no less real;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { claudeInstanceHomes, claudeProjectsDirCandidates } from "../provider/providerHomes.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const SCRIPT_BYTE_CAP = 256 * 1024;

/**
 * Candidate roots, before realpath: both layouts of every configured Claude
 * home. Settings that cannot be read degrade to the default home rather than
 * taking the feature down — the containment check is what makes a path safe,
 * and a shorter root list only ever refuses more.
 */
const candidateRoots = Effect.fn("orchestration.workflowScriptRoots")(function* () {
  const settings = yield* ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.catchCause((cause) =>
      Effect.logDebug("Workflow script roots fell back to the default Claude home.", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  const homes =
    settings === null
      ? [{ instanceIds: ["claudeAgent"], homePath: NodeOS.homedir(), overridden: false }]
      : yield* claudeInstanceHomes(settings);
  const roots: string[] = [];
  for (const home of homes) {
    roots.push(...(yield* claudeProjectsDirCandidates(home)));
  }
  return roots;
});

/**
 * Roots that exist, resolved through symlinks. A home that is configured but
 * not present on disk simply contributes nothing.
 */
const resolveRoots = Effect.fn("orchestration.resolveWorkflowScriptRoots")(function* () {
  const candidates = yield* candidateRoots();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const real = yield* Effect.tryPromise(() => NodeFSP.realpath(candidate)).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (real !== null && !resolved.includes(real)) resolved.push(real);
  }
  return resolved;
});

const isContainedBy = (resolved: string, root: string): boolean =>
  resolved === root || resolved.startsWith(`${root}${NodePath.sep}`);

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "invalid-path", scriptPath: requested }),
    );
  }

  const roots = yield* resolveRoots();
  if (roots.length === 0) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: requested,
      }),
    );
  }

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(requested),
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: requested,
        cause,
      }),
  });

  if (!roots.some((root) => isContainedBy(resolved, root))) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "outside-root", scriptPath: resolved }),
    );
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "not-js", scriptPath: resolved }),
    );
  }

  // TOCTOU-safe read (review finding): open FIRST, then verify what was
  // actually opened via the file descriptor. Re-checking the path after
  // open would race against a swap; fstat on the handle cannot. The two
  // containment checks fail with their own tagged reasons (not manufactured
  // Errors folded into read-failed); "read-failed" is reserved for genuine
  // platform failures with the real cause attached.
  const read = yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFSP.open(resolved, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { failure: "not-regular-file" as const };
        }
        // The opened inode must be the same one realpath resolved to: a
        // process swapping the path between realpath and open changes the
        // inode, which this comparison catches.
        const pathStat = await NodeFSP.lstat(resolved);
        if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
          return { failure: "changed-during-read" as const };
        }
        const truncated = stat.size > SCRIPT_BYTE_CAP;
        const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          contents: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: resolved,
        cause,
      }),
  });
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: resolved,
    });
  }

  return {
    scriptPath: resolved,
    contents: read.contents,
    truncated: read.truncated,
  };
});
