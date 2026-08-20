import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkflowDefinitions, resolveWorkflowsDir } from "./loader.ts";

async function fixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ops-workflows-"));
}

/** Writes one workflow subdirectory. `skillContent: null` omits the skill file entirely. */
async function writeWorkflow(
  root: string,
  name: string,
  options: { manifestJson: string; skillContent?: string | null; skillFile?: string },
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), options.manifestJson);
  if (options.skillContent !== null) {
    await writeFile(
      join(dir, options.skillFile ?? "SKILL.md"),
      options.skillContent ?? "# Skill\n",
    );
  }
}

const DEFAULT_TZ = { defaultTimezone: "Europe/London" };

describe("loadWorkflowDefinitions", () => {
  it("loads a valid workflow with a stable manifest hash", async () => {
    const manifest = {
      key: "prospect-research",
      title: "Prospect research",
      skill: "SKILL.md",
      schedules: [{ cron: "0 6 * * 1-5", timezone: "Europe/London" }],
    };

    const root = await fixtureDir();
    await writeWorkflow(root, "prospect-research", { manifestJson: JSON.stringify(manifest) });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.errors).toEqual([]);
    expect(result.definitions).toHaveLength(1);
    const def = result.definitions[0]!;
    expect(def.key).toBe("prospect-research");
    expect(def.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.skillPath).toBe(join("prospect-research", "SKILL.md"));

    // An identical fixture, written from scratch elsewhere, hashes the same.
    const root2 = await fixtureDir();
    await writeWorkflow(root2, "prospect-research", { manifestJson: JSON.stringify(manifest) });
    const result2 = await loadWorkflowDefinitions(root2, DEFAULT_TZ);
    expect(result2.definitions[0]?.manifestHash).toBe(def.manifestHash);
  });

  it("collects a JSON-invalid manifest as an error instead of throwing", async () => {
    const root = await fixtureDir();
    await writeWorkflow(root, "broken", { manifestJson: "{ not json", skillContent: null });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/not valid JSON/);
  });

  it("collects a schema-invalid manifest as an error instead of throwing", async () => {
    const root = await fixtureDir();
    await writeWorkflow(root, "bad-key", {
      manifestJson: JSON.stringify({ key: "Bad Key!", title: "Bad", skill: "SKILL.md" }),
    });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/failed validation/);
  });

  it("collects a missing skill file as an error", async () => {
    const root = await fixtureDir();
    await writeWorkflow(root, "no-skill", {
      manifestJson: JSON.stringify({ key: "no-skill", title: "No skill", skill: "SKILL.md" }),
      skillContent: null,
    });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/does not exist/);
  });

  it("loads the other workflows even when one directory is broken", async () => {
    const root = await fixtureDir();
    await writeWorkflow(root, "ok", {
      manifestJson: JSON.stringify({ key: "ok", title: "OK", skill: "SKILL.md" }),
    });
    await writeWorkflow(root, "broken", { manifestJson: "not json", skillContent: null });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions.map((d) => d.key)).toEqual(["ok"]);
    expect(result.errors).toHaveLength(1);
  });

  it("ignores subdirectories with no manifest.json", async () => {
    const root = await fixtureDir();
    await mkdir(join(root, "not-a-workflow"), { recursive: true });
    await writeFile(join(root, "not-a-workflow", "README.md"), "hi");

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("returns empty results for a workflows directory that does not exist", async () => {
    const root = await fixtureDir();
    const result = await loadWorkflowDefinitions(join(root, "does-not-exist"), DEFAULT_TZ);
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("collects a duplicate workflow key across two directories as an error", async () => {
    const root = await fixtureDir();
    await writeWorkflow(root, "first", {
      manifestJson: JSON.stringify({ key: "dup", title: "First", skill: "SKILL.md" }),
    });
    await writeWorkflow(root, "second", {
      manifestJson: JSON.stringify({ key: "dup", title: "Second", skill: "SKILL.md" }),
    });

    const result = await loadWorkflowDefinitions(root, DEFAULT_TZ);
    expect(result.definitions).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/already used by/);
  });
});

describe("resolveWorkflowsDir", () => {
  it("leaves an absolute path untouched", () => {
    expect(resolveWorkflowsDir("/abs/path")).toBe("/abs/path");
  });

  it("resolves a relative path against the package root, not process cwd", () => {
    const resolved = resolveWorkflowsDir("workflows");
    expect(resolved.endsWith(join("infra", "ops", "workflows"))).toBe(true);
  });
});
