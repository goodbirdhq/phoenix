import type { ModelSelection, ScheduleHistoryEntry } from "@t3tools/contracts";

export interface ScheduleModelChoice {
  readonly selection: ModelSelection;
  readonly isDefault: boolean;
}

interface ScheduleEditorDefaultsDraft {
  readonly environmentId: string;
  readonly projectId: string;
  readonly modelSelection: ModelSelection | null;
  readonly workspaceMode: "local" | "worktree";
  readonly workspaceCustomized: boolean;
  readonly baseBranch: string;
}

interface ScheduleEditorDefaultsInput {
  readonly environmentId: string;
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly defaultModelSelection: ModelSelection | null | undefined;
    readonly defaultThreadEnvMode?: "local" | "worktree" | null | undefined;
  }>;
  readonly modelChoices: ReadonlyArray<ScheduleModelChoice>;
  readonly serverDefaultModelSelection: ModelSelection | null | undefined;
  readonly isRepo: boolean | null;
  readonly branchRefs: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly isRemote?: boolean | undefined;
  }>;
  readonly editing: boolean;
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

/** Resolves a valid default while retaining the preferred selection's explicit options. */
export function chooseScheduleModelSelection(
  preferred: ReadonlyArray<ModelSelection | null | undefined>,
  choices: ReadonlyArray<ScheduleModelChoice>,
): ModelSelection | null {
  for (const selection of preferred) {
    if (selection && choices.some((choice) => sameModel(choice.selection, selection))) {
      return selection;
    }
  }
  return choices.find((choice) => choice.isDefault)?.selection ?? choices[0]?.selection ?? null;
}

export function modelSelectionValue(selection: ModelSelection | null): string {
  return selection === null ? "" : `${selection.instanceId}\u0000${selection.model}`;
}

export function resolveScheduleBaseBranch(
  refs: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly isRemote?: boolean | undefined;
  }>,
): string | null {
  return (
    refs.find((ref) => ref.isDefault)?.name ??
    refs.find((ref) => ref.current && ref.isRemote !== true)?.name ??
    null
  );
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

/** Applies asynchronously discovered editor defaults without emitting no-op state updates. */
export function reconcileScheduleEditorDefaults<T extends ScheduleEditorDefaultsDraft>(
  draft: T,
  input: ScheduleEditorDefaultsInput,
): T {
  if (draft.environmentId !== input.environmentId) return draft;

  const project =
    input.projects.find((candidate) => candidate.id === draft.projectId) ?? input.projects[0];
  const projectId = project?.id ?? "";
  const modelSelection = input.modelChoices.some(
    (choice) => draft.modelSelection !== null && sameModel(choice.selection, draft.modelSelection),
  )
    ? draft.modelSelection
    : chooseScheduleModelSelection(
        [project?.defaultModelSelection, input.serverDefaultModelSelection],
        input.modelChoices,
      );
  const workspaceMode = draft.workspaceCustomized
    ? draft.workspaceMode
    : resolveScheduleWorkspaceModeDefault(project === undefined ? null : input.isRepo);
  const resolvedBranch =
    !input.editing && workspaceMode === "worktree" && draft.baseBranch === "origin/HEAD"
      ? resolveScheduleBaseBranch(input.branchRefs)
      : null;
  const baseBranch = resolvedBranch ?? draft.baseBranch;

  if (
    projectId === draft.projectId &&
    modelSelection === draft.modelSelection &&
    workspaceMode === draft.workspaceMode &&
    baseBranch === draft.baseBranch
  ) {
    return draft;
  }

  return {
    ...draft,
    projectId,
    modelSelection,
    workspaceMode,
    baseBranch,
  };
}

export function schedulePauseFieldLabel(editing: boolean): "Create Paused" | null {
  return editing ? null : "Create Paused";
}

export function scheduleFailureAttentionVersion(
  unacknowledged: boolean,
  latest: ScheduleHistoryEntry | null,
  updatedAt: string,
): string | null {
  if (!unacknowledged) return null;
  return latest?.type === "failed" ? `failed:${latest.occurrenceId}` : `updated:${updatedAt}`;
}

export interface LatestScheduleHistorySummary {
  readonly label: string;
  readonly detail: string;
  readonly at: string;
}

export function latestScheduleHistorySummary(
  entry: ScheduleHistoryEntry,
): LatestScheduleHistorySummary {
  switch (entry.type) {
    case "triggered":
      return { label: "Triggered", detail: entry.scheduledFor, at: entry.triggeredAt };
    case "failed":
      return {
        label:
          entry.count === 1
            ? "Failed"
            : entry.count === 2
              ? "Failed twice"
              : `Failed ${entry.count} times`,
        detail: entry.message,
        at: entry.lastFailedAt,
      };
    case "skipped":
      return {
        label: `Skipped ${entry.countIsLowerBound ? "at least " : ""}${entry.count.toLocaleString("en-US")} Occurrences`,
        detail: `${entry.firstScheduledFor} – ${entry.lastScheduledFor}`,
        at: entry.recordedAt,
      };
  }
}

export function latestScheduleHistoryListText(
  entry: ScheduleHistoryEntry,
  formatDate: (value: string) => string,
): string {
  const summary = latestScheduleHistorySummary(entry);
  switch (entry.type) {
    case "triggered":
      return `${summary.label} · ${formatDate(entry.triggeredAt)}`;
    case "failed":
      return `${summary.label} · ${entry.message} · ${formatDate(entry.lastFailedAt)}`;
    case "skipped":
      return `${summary.label} · ${formatDate(entry.firstScheduledFor)} – ${formatDate(entry.lastScheduledFor)}`;
  }
}

export function scheduleHistoryEntryKey(entry: ScheduleHistoryEntry): string {
  switch (entry.type) {
    case "triggered":
    case "failed":
      return `${entry.type}:${entry.occurrenceId}`;
    case "skipped":
      return `${entry.type}:${entry.firstScheduledFor}:${entry.lastScheduledFor}:${entry.recordedAt}`;
  }
}

/** Keeps the actively rendered history window bounded while traversing toward older pages. */
export function prependOlderScheduleHistory(
  older: ReadonlyArray<ScheduleHistoryEntry>,
  current: ReadonlyArray<ScheduleHistoryEntry>,
  limit: number,
): ReadonlyArray<ScheduleHistoryEntry> {
  const seen = new Set<string>();
  const merged: ScheduleHistoryEntry[] = [];
  for (const entry of [...older, ...current]) {
    const key = scheduleHistoryEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
    if (merged.length === limit) break;
  }
  return merged;
}
