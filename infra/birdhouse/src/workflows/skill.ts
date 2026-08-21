import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { config } from "../config.ts";
import { resolveWorkflowsDir } from "./loader.ts";

// `workflow.skill_path` is stored relative to the workflows root
// (`BIRDHOUSE_WORKFLOWS_DIR`), which is where the loader wrote it — so this
// resolves it with the loader's own rule rather than a second copy that
// could drift and leave the maintenance loop syncing a skill neither the
// launch handler nor the claim route can find.
export async function loadSkillMarkdown(skillPath: string): Promise<string> {
  const resolved = NodePath.isAbsolute(skillPath)
    ? skillPath
    : NodePath.resolve(resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR), skillPath);
  return NodeFSP.readFile(resolved, "utf8");
}
