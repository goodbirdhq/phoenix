export interface ScheduleBranchRef {
  readonly name: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly isRemote?: boolean | undefined;
}

export function scheduleWorktreeCapability(isRepo: boolean | null): {
  readonly allowed: boolean;
  readonly pendingValidation: boolean;
} {
  return {
    allowed: isRepo === true,
    pendingValidation: isRepo === null,
  };
}

export function resolveScheduleWorkspaceModeDefault(isRepo: boolean | null): "local" | "worktree" {
  return isRepo === true ? "worktree" : "local";
}

export function canSelectScheduleWorkspaceMode(
  isRepo: boolean | null,
  workspaceMode: "local" | "worktree",
): boolean {
  return workspaceMode === "local" || isRepo === true;
}

export function scheduleBaseBranch(
  workspaceMode: "local" | "worktree",
  baseBranch: string,
): string | null {
  return workspaceMode === "worktree" ? baseBranch.trim() || null : null;
}

export function preferredScheduleBaseBranch(refs: ReadonlyArray<ScheduleBranchRef>): string | null {
  return (
    refs.find((ref) => ref.isDefault && ref.isRemote === true)?.name ??
    refs.find((ref) => ref.isDefault)?.name ??
    refs.find((ref) => ref.current && ref.isRemote !== true)?.name ??
    refs.find((ref) => ref.current)?.name ??
    null
  );
}
