import { describe, expect, it } from "vite-plus/test";

import {
  canSelectScheduleWorkspaceMode,
  preferredScheduleBaseBranch,
  resolveScheduleWorkspaceModeDefault,
  scheduleBaseBranch,
  scheduleWorktreeCapability,
} from "./workspace.ts";

describe("Schedule workspace policy", () => {
  it("offers worktrees only after Git is authoritatively confirmed", () => {
    expect(scheduleWorktreeCapability(null)).toEqual({
      allowed: false,
      pendingValidation: true,
    });
    expect(scheduleWorktreeCapability(false).allowed).toBe(false);
    expect(scheduleWorktreeCapability(true).allowed).toBe(true);
    expect(resolveScheduleWorkspaceModeDefault(true)).toBe("worktree");
    expect(resolveScheduleWorkspaceModeDefault(null)).toBe("local");
    expect(canSelectScheduleWorkspaceMode(null, "local")).toBe(true);
    expect(canSelectScheduleWorkspaceMode(null, "worktree")).toBe(false);
  });

  it("prefers a configured remote default and persists branches only for worktrees", () => {
    expect(
      preferredScheduleBaseBranch([
        { name: "feature", current: true, isDefault: false, isRemote: false },
        { name: "origin/main", current: false, isDefault: true, isRemote: true },
      ]),
    ).toBe("origin/main");
    expect(scheduleBaseBranch("worktree", " origin/main ")).toBe("origin/main");
    expect(scheduleBaseBranch("local", "origin/main")).toBeNull();
  });
});
