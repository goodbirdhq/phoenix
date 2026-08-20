import type { ModelSelection, ScheduleHistoryEntry } from "@t3tools/contracts";
import {
  preferredScheduleBaseBranch,
  resolveScheduleWorkspaceModeDefault,
  scheduleWorktreeCapability,
} from "@t3tools/client-runtime/schedules";

export { resolveScheduleWorkspaceModeDefault, scheduleWorktreeCapability };

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
  return preferredScheduleBaseBranch(refs);
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

export function shouldOpenScheduleCreateRequest(
  previousRequest: string | null,
  nextRequest: string | null,
): boolean {
  return nextRequest !== null && nextRequest !== previousRequest;
}

export function scheduleFailureAttentionVersion(
  unacknowledged: boolean,
  latest: ScheduleHistoryEntry | null,
  updatedAt: string,
): string | null {
  if (!unacknowledged) return null;
  return latest?.type === "failed" ? `failed:${latest.occurrenceId}` : `updated:${updatedAt}`;
}

export {
  latestScheduleHistoryListText,
  latestScheduleHistorySummary,
  prependOlderScheduleHistory,
  scheduleHistoryEntryKey,
} from "@t3tools/client-runtime/schedules";
