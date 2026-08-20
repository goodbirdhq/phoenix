import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { workflow, workflowSchedule } from "../db/schema.ts";
import { canonicalJsonHash } from "../lib/canonical-json.ts";
import { nextCronOccurrence } from "../lib/cron.ts";
import { createWorkflowManifestSchema, type WorkflowManifest } from "./manifest.ts";

// From src/workflows/loader.ts, two levels up is the package root
// (infra/ops) — matches OPS_WORKFLOWS_DIR's documented "relative paths
// resolve against the package root, not the process cwd" contract.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function resolveWorkflowsDir(configuredDir: string): string {
  return isAbsolute(configuredDir) ? configuredDir : resolve(PACKAGE_ROOT, configuredDir);
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
export async function loadWorkflowDefinitions(
  dir: string,
  options: { defaultTimezone?: string } = {},
): Promise<WorkflowLoadResult> {
  // See manifest.ts: this is the one place config.ts is allowed to leak in,
  // and only when the caller didn't already supply a timezone (production
  // callers always do; tests pass one explicitly to stay DB-config-free).
  const defaultTimezone =
    options.defaultTimezone ?? (await import("../config.ts")).config.OPS_TIMEZONE;
  const schema = createWorkflowManifestSchema(defaultTimezone);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { definitions: [], errors: [] };
    throw error;
  }

  const definitions: WorkflowDefinition[] = [];
  const errors: WorkflowLoadError[] = [];
  const keyOwners = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workflowDir = join(dir, entry.name);
    const manifestPath = join(workflowDir, "manifest.json");

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
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

    const absoluteSkillPath = join(workflowDir, manifest.skill);
    try {
      await access(absoluteSkillPath);
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
      skillPath: join(entry.name, manifest.skill),
    });
  }

  return { definitions, errors };
}

export type WorkflowSyncSummary = Readonly<{
  workflowsUpserted: number;
  schedulesUpserted: number;
  schedulesDisabledMissing: number;
  workflowsDisabledMissing: number;
}>;

/**
 * Projects disk-defined workflows into the `workflow` / `workflow_schedule`
 * tables. `workflow.mode` and `workflow.enabled` are operational toggles,
 * not disk state: the upsert below never writes them for a row that already
 * exists — new rows just take the column defaults. Reconciliation (the two
 * loops after the upserts) is the only place that flips `enabled`, and only
 * to turn things off that disk no longer declares; nothing here ever
 * deletes a row.
 */
export async function syncWorkflows(
  db: Db,
  definitions: readonly WorkflowDefinition[],
): Promise<WorkflowSyncSummary> {
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
      });
    workflowsUpserted = definitions.length;
  }

  let schedulesUpserted = 0;
  if (definitions.length > 0) {
    const desired = definitions.flatMap((def) =>
      def.manifest.schedules.map((schedule) => ({
        workflowKey: def.key,
        cron: schedule.cron,
        timezone: schedule.timezone,
        enabled: schedule.enabled,
        // Only takes effect for a genuinely new row: the `set` clause below
        // deliberately omits next_run_at so an existing schedule's progress
        // survives every tick's re-sync (this runs once per tick).
        nextRunAt: nextCronOccurrence(schedule.cron, schedule.timezone, now),
      })),
    );
    if (desired.length > 0) {
      await db
        .insert(workflowSchedule)
        .values(desired)
        .onConflictDoUpdate({
          target: [workflowSchedule.workflowKey, workflowSchedule.cron],
          set: {
            timezone: sql`excluded.timezone`,
            enabled: sql`excluded.enabled`,
            updatedAt: now,
          },
        });
      schedulesUpserted = desired.length;
    }
  }

  // Disable schedules that were synced from a workflow still on disk, but
  // whose particular cron entry disk no longer declares.
  let schedulesDisabledMissing = 0;
  for (const def of definitions) {
    const cronsOnDisk = def.manifest.schedules.map((s) => s.cron);
    const result = await db
      .update(workflowSchedule)
      .set({ enabled: false, updatedAt: now })
      .where(
        cronsOnDisk.length > 0
          ? and(
              eq(workflowSchedule.workflowKey, def.key),
              notInArray(workflowSchedule.cron, cronsOnDisk),
              eq(workflowSchedule.enabled, true),
            )
          : and(eq(workflowSchedule.workflowKey, def.key), eq(workflowSchedule.enabled, true)),
      )
      .returning({ id: workflowSchedule.id });
    schedulesDisabledMissing += result.length;
  }

  // Disable workflows this sync didn't see on disk at all — but only ones a
  // previous sync actually created (`synced_at is not null`); a workflow
  // row seeded some other way is left alone.
  const diskKeys = definitions.map((def) => def.key);
  const missingWorkflows = await db
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
    schedulesUpserted,
    schedulesDisabledMissing,
    workflowsDisabledMissing: missingWorkflows.length,
  };
  console.log(JSON.stringify({ event: "workflows.synced", ...summary }));
  return summary;
}
