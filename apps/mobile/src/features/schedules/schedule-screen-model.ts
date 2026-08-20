import {
  aggregateSchedules,
  canSelectScheduleWorkspaceMode,
  filterScheduleRows,
  formatScheduleTimestamp,
  formatScheduleTiming,
  inspectCronTiming,
  latestScheduleHistoryListText,
  mergeOlderScheduleHistory,
  preferredScheduleBaseBranch,
  resolveScheduleWorkspaceModeDefault,
  scheduleBaseBranch,
  scheduleHistoryEntryKey,
  scheduleTimeZoneIsValid,
  scheduleWallTimeInputForInstant,
} from "@t3tools/client-runtime/schedules";
import {
  EnvironmentId,
  ProjectId,
  type ScheduleExecution,
  type ScheduleHistoryEntry,
  type ScheduleState,
  type ScheduleSummary,
  type ScheduleTiming,
} from "@t3tools/contracts";

export interface MobileSchedule extends ScheduleSummary {
  readonly environmentId: string;
}

export interface ScheduleProject {
  readonly projectId: string;
  readonly title: string;
  readonly isGit: boolean | null;
}

export interface ScheduleEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly online: boolean;
  readonly projects: readonly ScheduleProject[];
}

export interface ScheduleFilters {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly state: ScheduleState | null;
  readonly failuresOnly: boolean;
}

export interface ScheduleRow {
  readonly scheduleId: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly projectId: string;
  readonly projectLabel: string;
  readonly name: string;
  readonly state: ScheduleState;
  readonly timingLabel: string;
  readonly nextOccurrenceAt: string | null;
  readonly nextOccurrenceLabel: string;
  readonly latestHistoryLabel: string | null;
  readonly offline: boolean;
  readonly readOnly: boolean;
  readonly hasFailureAttention: boolean;
}

export interface ScheduleDraft {
  readonly name: string;
  readonly prompt: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly timing: ScheduleTiming;
  readonly timeZone: string;
  readonly execution: ScheduleExecution;
  readonly createPaused: boolean;
}

export interface ScheduleDraftErrors {
  readonly name?: string;
  readonly prompt?: string;
  readonly environment?: string;
  readonly project?: string;
  readonly timing?: string;
  readonly timeZone?: string;
  readonly workspace?: string;
}

export function defaultScheduleWorkspaceMode(isGit: boolean | null): "local" | "worktree" | null {
  return isGit === null ? null : resolveScheduleWorkspaceModeDefault(isGit);
}

export { canSelectScheduleWorkspaceMode, preferredScheduleBaseBranch, scheduleBaseBranch };

function timestampLabel(value: string, timeZone: string): string {
  return `${formatScheduleTimestamp(value, timeZone)} · ${timeZone}`;
}

function latestHistoryLabel(entry: ScheduleHistoryEntry | null, timeZone: string): string | null {
  return entry === null
    ? null
    : latestScheduleHistoryListText(entry, (value) => timestampLabel(value, timeZone));
}

export function buildScheduleRows(input: {
  readonly environments: readonly ScheduleEnvironment[];
  readonly schedules: readonly MobileSchedule[];
  readonly filters: ScheduleFilters;
}): readonly ScheduleRow[] {
  const environmentsById = new Map(
    input.environments.map((environment) => [
      EnvironmentId.make(environment.environmentId),
      environment,
    ]),
  );
  const rows = aggregateSchedules(
    input.environments.map((environment) => ({
      environmentId: EnvironmentId.make(environment.environmentId),
      environmentLabel: environment.label,
      source: environment.online ? ("live" as const) : ("cache" as const),
      online: environment.online,
      supportsSchedules: true,
      snapshotSequence: 0,
      schedules: input.schedules.filter(
        (schedule) => schedule.environmentId === environment.environmentId,
      ),
    })),
  );
  const filtered = filterScheduleRows(rows, {
    environmentIds: new Set(
      input.filters.environmentId === null ? [] : [EnvironmentId.make(input.filters.environmentId)],
    ),
    projectIds: new Set(
      input.filters.projectId === null ? [] : [ProjectId.make(input.filters.projectId)],
    ),
    states: new Set(input.filters.state === null ? [] : [input.filters.state]),
    failures: input.filters.failuresOnly ? "only" : "all",
  });

  return filtered
    .map((schedule): ScheduleRow => {
      const environment = environmentsById.get(schedule.environmentId)!;
      const project = environment.projects.find(
        (candidate) => candidate.projectId === schedule.projectId,
      );
      return {
        scheduleId: schedule.id,
        environmentId: schedule.environmentId,
        environmentLabel: environment.label,
        projectId: schedule.projectId,
        projectLabel: project?.title ?? "Unknown project",
        name: schedule.name,
        state: schedule.state,
        timingLabel: formatScheduleTiming(schedule.timing, schedule.timeZone),
        nextOccurrenceAt: schedule.nextOccurrenceAt,
        nextOccurrenceLabel:
          schedule.nextOccurrenceAt === null
            ? "No upcoming occurrence"
            : `Next · ${timestampLabel(schedule.nextOccurrenceAt, schedule.timeZone)}`,
        latestHistoryLabel: latestHistoryLabel(schedule.latestHistory, schedule.timeZone),
        offline: !environment.online,
        readOnly: !environment.online,
        hasFailureAttention: schedule.unacknowledgedFailure,
      };
    })
    .sort((left, right) => {
      const leftTime = left.nextOccurrenceAt ?? "9999";
      const rightTime = right.nextOccurrenceAt ?? "9999";
      return leftTime.localeCompare(rightTime) || left.name.localeCompare(right.name);
    });
}

export function validateScheduleDraft(
  draft: ScheduleDraft,
  environments: readonly ScheduleEnvironment[],
  now: Date = new Date(),
  editSource?: Pick<ScheduleSummary, "state" | "timing">,
): { readonly valid: boolean; readonly errors: ScheduleDraftErrors } {
  const errors: Record<string, string> = {};
  const environment = environments.find(
    (candidate) => candidate.environmentId === draft.environmentId,
  );
  const project = environment?.projects.find(
    (candidate) => candidate.projectId === draft.projectId,
  );
  if (draft.name.trim().length === 0) errors.name = "Enter a short name.";
  if (draft.prompt.trim().length === 0) errors.prompt = "Enter a prompt.";
  if (!environment) errors.environment = "Choose an environment.";
  else if (!environment.online) errors.environment = "Connect this environment to make changes.";
  if (!project) errors.project = "Choose a project.";
  const timeZoneValid = scheduleTimeZoneIsValid(draft.timeZone);
  const cronInspection =
    draft.timing.type === "cron"
      ? inspectCronTiming({
          expression: draft.timing.expression,
          timeZone: draft.timeZone,
          after: now,
        })
      : null;
  if (!timeZoneValid) {
    errors.timeZone = "Choose a valid time zone.";
  }

  if (draft.timing.type === "one-time") {
    const runAt = new Date(draft.timing.runAt);
    const keepsInactiveOneTimeOccurrence =
      editSource !== undefined &&
      editSource.state !== "enabled" &&
      editSource.timing.type === "one-time" &&
      editSource.timing.runAt === draft.timing.runAt;
    if (
      !Number.isFinite(runAt.getTime()) ||
      (runAt.getTime() <= now.getTime() && !keepsInactiveOneTimeOccurrence)
    ) {
      errors.timing = "Choose a future time.";
    }
  } else if (cronInspection !== null && !cronInspection.valid && errors.timeZone === undefined) {
    errors.timing =
      cronInspection.error === "Schedules cannot run more often than every 5 minutes."
        ? "Recurring Schedules must be at least five minutes apart."
        : "Enter a valid five-field cron rule.";
  }

  if (draft.execution.workspaceMode === "worktree" && project) {
    if (project.isGit === null) {
      errors.workspace = "Worktrees are unavailable until Git status is known.";
    } else if (!project.isGit) {
      errors.workspace = "Worktrees require a Git repository.";
    } else if (draft.execution.baseBranch === null) {
      errors.workspace = "Choose a base branch before saving a worktree Schedule.";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function getFrequentScheduleWarning(expression: string): string | null {
  const inspection = inspectCronTiming({ expression, timeZone: "UTC", after: new Date(0) });
  if (!inspection.valid || !inspection.highFrequency) return null;
  return "Every 5 minutes can create 288 Threads per day (about 105,000 per year). Phoenix does not automatically delete those Threads or their worktrees.";
}

export function previewCronOccurrences(
  expression: string,
  timeZone: string,
  after: Date = new Date(),
): readonly string[] {
  return inspectCronTiming({ expression, timeZone, after }).occurrences;
}

export const wallTimeInputForInstant = scheduleWallTimeInputForInstant;

export const MAX_VISIBLE_SCHEDULE_HISTORY = 150;

export { mergeOlderScheduleHistory, scheduleHistoryEntryKey };
