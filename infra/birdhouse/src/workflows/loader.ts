import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { workflow } from "../db/schema.ts";
import { canonicalJsonHash } from "../lib/canonical-json.ts";
import { createWorkflowManifestSchema, type WorkflowManifest } from "./manifest.ts";

// From src/workflows/loader.ts, two levels up is the package root
// (infra/birdhouse) — matches BIRDHOUSE_WORKFLOWS_DIR's documented "relative paths
// resolve against the package root, not the process cwd" contract.
const PACKAGE_ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

export function resolveWorkflowsDir(configuredDir: string): string {
  return NodePath.isAbsolute(configuredDir)
    ? configuredDir
    : NodePath.resolve(PACKAGE_ROOT, configuredDir);
}

export type WorkflowDefinition = Readonly<{
  key: string;
  /** Absolute path to the workflow's own directory. */
  dir: string;
  manifest: WorkflowManifest;
  /** Canonical hash of the validated manifest (defaults applied). */
  manifestHash: string;
  /** Path to the skill file, relative to the workflows root — stored in `workflow.skill_path`. */
  skillPath: string;
}>;

export type WorkflowLoadError = Readonly<{ dir: string; message: string }>;

export type WorkflowLoadResult = Readonly<{
  definitions: readonly WorkflowDefinition[];
  errors: readonly WorkflowLoadError[];
}>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scans each subdirectory of `dir` for a `manifest.json`, validates it
 * against the workflow manifest schema, and confirms the skill file it
 * references exists. A bad manifest in one workflow directory never stops
 * the others from loading — every failure is collected into `errors`
 * instead of thrown, so one broken workflow can't take the rest offline.
 */
export async function loadWorkflowDefinitions(dir: string): Promise<WorkflowLoadResult> {
  const schema = createWorkflowManifestSchema();

  let entries;
  try {
    entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // An unreadable workflows root is an error, never an empty tree. Reading
    // it as "zero workflows on disk" is indistinguishable from "every
    // workflow was deleted", and reconciliation would then disable the lot —
    // a mistyped BIRDHOUSE_WORKFLOWS_DIR, or one tick from the wrong
    // checkout, taking the whole service offline.
    return {
      definitions: [],
      errors: [{ dir, message: `workflows directory could not be read: ${describeError(error)}` }],
    };
  }

  const definitions: WorkflowDefinition[] = [];
  const errors: WorkflowLoadError[] = [];
  const keyOwners = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workflowDir = NodePath.join(dir, entry.name);
    const manifestPath = NodePath.join(workflowDir, "manifest.json");

    let raw: string;
    try {
      raw = await NodeFSP.readFile(manifestPath, "utf8");
    } catch (error) {
      // Not every subdirectory of the workflows root has to be a workflow
      // (shared fixtures, scratch dirs); only a missing manifest.json is
      // silent — anything else reading it is a real problem.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push({
        dir: workflowDir,
        message: `failed to read manifest.json: ${describeError(error)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({
        dir: workflowDir,
        message: `manifest.json is not valid JSON: ${describeError(error)}`,
      });
      continue;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      errors.push({ dir: workflowDir, message: `manifest.json failed validation: ${detail}` });
      continue;
    }
    const manifest = result.data;

    const existingOwner = keyOwners.get(manifest.key);
    if (existingOwner) {
      errors.push({
        dir: workflowDir,
        message: `workflow key "${manifest.key}" is already used by ${existingOwner}`,
      });
      continue;
    }

    const absoluteSkillPath = NodePath.join(workflowDir, manifest.skill);
    try {
      await NodeFSP.access(absoluteSkillPath);
    } catch {
      errors.push({ dir: workflowDir, message: `skill file "${manifest.skill}" does not exist` });
      continue;
    }

    keyOwners.set(manifest.key, workflowDir);
    definitions.push({
      key: manifest.key,
      dir: workflowDir,
      manifest,
      manifestHash: canonicalJsonHash(manifest),
      skillPath: NodePath.join(entry.name, manifest.skill),
    });
  }

  return { definitions, errors };
}

export type WorkflowSyncSummary = Readonly<{
  workflowsUpserted: number;
  workflowsDisabledMissing: number;
  /** False when load errors made the disk view too incomplete to disable anything. */
  reconciled: boolean;
}>;

/**
 * Projects disk-defined workflows into the `workflow` table. `workflow.mode`
 * and `workflow.enabled` are operational toggles, not disk state: the
 * upsert below never writes them for a row that already exists — new rows
 * just take the column defaults. Reconciliation (the loop after the upsert)
 * is the only place that flips `enabled`, and only to turn things off that
 * disk no longer declares; nothing here ever deletes a row.
 */
export async function syncWorkflows(
  db: Db,
  definitions: readonly WorkflowDefinition[],
  options: { reconcileMissing?: boolean } = {},
): Promise<WorkflowSyncSummary> {
  // Disabling things disk no longer declares is only sound when this load
  // saw the whole tree. Callers pass false whenever anything failed to load,
  // because a workflow that's briefly unreadable (a manifest being edited, a
  // half-finished checkout) is not a workflow that was deleted — and the
  // upsert deliberately never writes `enabled` back, so a wrong disable
  // stands until an operator undoes it by hand.
  const reconcileMissing = options.reconcileMissing ?? true;
  const now = new Date();

  let workflowsUpserted = 0;
  if (definitions.length > 0) {
    await db
      .insert(workflow)
      .values(
        definitions.map((def) => ({
          key: def.key,
          title: def.manifest.title,
          description: def.manifest.description ?? null,
          skillPath: def.skillPath,
          manifest: def.manifest as unknown as Record<string, unknown>,
          manifestHash: def.manifestHash,
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: workflow.key,
        set: {
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          skillPath: sql`excluded.skill_path`,
          manifest: sql`excluded.manifest`,
          manifestHash: sql`excluded.manifest_hash`,
          syncedAt: sql`excluded.synced_at`,
          updatedAt: now,
        },
        // What `manifest_hash` is for. This runs every tick, and Postgres
        // rewrites the whole row — jsonb manifest included — for an update
        // that changes nothing but `synced_at`. Skipping the no-op write
        // keeps a table of a dozen live rows from accumulating dead tuples
        // (and WAL) all day on a box that also serves interactive work.
        setWhere: sql`${workflow.manifestHash} is distinct from excluded.manifest_hash`,
      });
    workflowsUpserted = definitions.length;
  }

  // Disable workflows this sync didn't see on disk at all — but only ones a
  // previous sync actually created (`synced_at is not null`); a workflow
  // row seeded some other way is left alone.
  const diskKeys = definitions.map((def) => def.key);
  const missingWorkflows = !reconcileMissing
    ? []
    : await db
        .update(workflow)
        .set({ enabled: false, updatedAt: now })
        .where(
          diskKeys.length > 0
            ? and(
                notInArray(workflow.key, diskKeys),
                eq(workflow.enabled, true),
                sql`${workflow.syncedAt} is not null`,
              )
            : and(eq(workflow.enabled, true), sql`${workflow.syncedAt} is not null`),
        )
        .returning({ key: workflow.key });

  const summary: WorkflowSyncSummary = {
    workflowsUpserted,
    workflowsDisabledMissing: missingWorkflows.length,
    reconciled: reconcileMissing,
  };
  console.log(JSON.stringify({ event: "workflows.synced", ...summary }));
  return summary;
}
