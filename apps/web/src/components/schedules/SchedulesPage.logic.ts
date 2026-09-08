import { describeScheduleCadence } from "@t3tools/shared/scheduleCadence";
import type { ModelSelection, ScheduleHistoryEntry, ScheduleTiming } from "@t3tools/contracts";
import {
  type AggregatedScheduleRow,
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
  const projectId = input.editing && draft.projectId ? draft.projectId : (project?.id ?? "");
  const modelSelection =
    (input.editing && draft.modelSelection !== null) ||
    input.modelChoices.some(
      (choice) =>
        draft.modelSelection !== null && sameModel(choice.selection, draft.modelSelection),
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

/** Compact destination timestamp; keep the year when it would otherwise be ambiguous. */
export function scheduleDisplayTimestamp(
  value: string,
  timeZone: string,
  now = new Date(),
): string {
  try {
    const date = new Date(value);
    const year = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone });
    const parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone,
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
    const day = `${part("weekday")}, ${part("day")} ${part("month")}${year.format(date) !== year.format(now) ? ` ${year.format(date)}` : ""}`;
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(date);
    return `${day} · ${time}`;
  } catch {
    return value;
  }
}

export function scheduleRepeatSummary(timing: ScheduleTiming, timeZone: string) {
  if (timing.type === "one-time")
    return { value: "One time", description: "Runs once at the saved time" };
  const cadence = describeScheduleCadence(timing, timeZone);
  const split =
    /^(Weekdays|Every day|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays) at (\d{2}:\d{2})$/u.exec(
      cadence,
    );
  return split
    ? {
        value: split[1]!,
        description: `At ${split[2]}${split[1] === "Weekdays" ? " · Mon–Fri" : ""}`,
      }
    : { value: cadence, description: timing.expression };
}

/** Show the next connected occurrence first, leaving cached offline work at the end. */
export function compareScheduleSidebarRows(
  left: Pick<AggregatedScheduleRow, "state" | "online" | "nextOccurrenceAt" | "name">,
  right: Pick<AggregatedScheduleRow, "state" | "online" | "nextOccurrenceAt" | "name">,
) {
  if (left.state === "enabled" && right.state === "enabled") {
    if (left.online !== right.online) return left.online ? -1 : 1;
    const leftTime = left.nextOccurrenceAt === null ? Infinity : Date.parse(left.nextOccurrenceAt);
    const rightTime =
      right.nextOccurrenceAt === null ? Infinity : Date.parse(right.nextOccurrenceAt);
    if (leftTime !== rightTime) return leftTime - rightTime;
  }
  return left.name.localeCompare(right.name);
}

export function schedulePromptExplanation(
  state: AggregatedScheduleRow["state"],
  latestOutcome: ScheduleHistoryEntry["type"] | null,
) {
  if (state === "failed")
    return latestOutcome === "triggered"
      ? "The latest run created a thread. Edit the schedule to enable future occurrences."
      : "This schedule could not start its thread. Failures after a thread starts are shown in the thread.";
  if (state === "completed")
    return latestOutcome === "triggered"
      ? "The scheduled thread was created. Open it to see the agent’s progress."
      : "This one-time schedule is completed. Review its history for recorded occurrences.";
  return "Each occurrence starts a fresh thread. Agent progress and approvals appear in that thread.";
}

export function scheduleHistoryScheduledLabel(
  entry: ScheduleHistoryEntry,
  timeZone: string,
  compact: boolean,
) {
  const label = (value: string) => {
    const formatted = scheduleDisplayTimestamp(value, timeZone);
    return compact ? formatted : formatted.replace(/^[^,]+, /u, "");
  };
  if (entry.type !== "skipped") return label(entry.scheduledFor);
  const first = label(entry.firstScheduledFor).split(" · ")[0];
  const last = label(entry.lastScheduledFor).split(" · ")[0];
  return first === last ? first : `${first} – ${last}`;
}

export function scheduleHistoryStartedLabel(
  entry: Extract<ScheduleHistoryEntry, { type: "triggered" }>,
  timeZone: string,
) {
  const started = scheduleDisplayTimestamp(entry.triggeredAt, timeZone);
  const scheduled = scheduleDisplayTimestamp(entry.scheduledFor, timeZone);
  if (!started.includes(" · ")) return `Started ${started}`;
  return started.split(" · ")[0] === scheduled.split(" · ")[0]
    ? `Started at ${started.split(" · ")[1]}`
    : `Started ${started}`;
}
