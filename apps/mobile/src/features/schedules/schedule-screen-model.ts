import { inspectCronTiming } from "@t3tools/client-runtime/schedules";
import type {
  ScheduleExecution,
  ScheduleHistoryEntry,
  ScheduleState,
  ScheduleSummary,
  ScheduleTiming,
  VcsRef,
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
  return isGit === null ? null : isGit ? "worktree" : "local";
}

export function canSelectScheduleWorkspaceMode(
  isGit: boolean | null,
  workspaceMode: "local" | "worktree",
): boolean {
  return workspaceMode === "local" || isGit === true;
}

export function scheduleBaseBranch(
  workspaceMode: "local" | "worktree",
  baseBranch: string,
): string | null {
  return workspaceMode === "worktree" ? baseBranch.trim() || null : null;
}

export function preferredScheduleBaseBranch(
  refs: readonly Pick<VcsRef, "name" | "current" | "isDefault" | "isRemote">[],
): string | null {
  return (
    refs.find((ref) => ref.isDefault && ref.isRemote === true)?.name ??
    refs.find((ref) => ref.isDefault)?.name ??
    refs.find((ref) => ref.current)?.name ??
    null
  );
}

function timingLabel(timing: ScheduleTiming, timeZone: string): string {
  if (timing.type === "cron") return `${timing.expression} · ${timeZone}`;
  try {
    return `Once · ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(timing.runAt))} · ${timeZone}`;
  } catch {
    return `Once · ${timing.runAt} · ${timeZone}`;
  }
}

export function buildScheduleRows(input: {
  readonly environments: readonly ScheduleEnvironment[];
  readonly schedules: readonly MobileSchedule[];
  readonly filters: ScheduleFilters;
}): readonly ScheduleRow[] {
  const environments = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );

  return input.schedules
    .flatMap((schedule): readonly ScheduleRow[] => {
      const environment = environments.get(schedule.environmentId);
      if (!environment) return [];
      const project = environment.projects.find(
        (candidate) => candidate.projectId === schedule.projectId,
      );
      const filters = input.filters;
      if (filters.environmentId !== null && schedule.environmentId !== filters.environmentId)
        return [];
      if (filters.projectId !== null && schedule.projectId !== filters.projectId) return [];
      if (filters.state !== null && schedule.state !== filters.state) return [];
      if (filters.failuresOnly && schedule.state !== "failed" && !schedule.unacknowledgedFailure)
        return [];

      return [
        {
          scheduleId: schedule.id,
          environmentId: schedule.environmentId,
          environmentLabel: environment.label,
          projectId: schedule.projectId,
          projectLabel: project?.title ?? "Unknown project",
          name: schedule.name,
          state: schedule.state,
          timingLabel: timingLabel(schedule.timing, schedule.timeZone),
          nextOccurrenceAt: schedule.nextOccurrenceAt,
          offline: !environment.online,
          readOnly: !environment.online,
          hasFailureAttention: schedule.unacknowledgedFailure,
        },
      ];
    })
    .sort((left, right) => {
      const leftTime = left.nextOccurrenceAt ?? "9999";
      const rightTime = right.nextOccurrenceAt ?? "9999";
      return leftTime.localeCompare(rightTime) || left.name.localeCompare(right.name);
    });
}

function timeZoneIsValid(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validateScheduleDraft(
  draft: ScheduleDraft,
  environments: readonly ScheduleEnvironment[],
  now: Date = new Date(),
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
  const timeZoneValid = timeZoneIsValid(draft.timeZone);
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
    if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= now.getTime()) {
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

export function wallTimeInputForInstant(instant: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const input = `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(input) ? input : null;
  } catch {
    return null;
  }
}

export const MAX_VISIBLE_SCHEDULE_HISTORY = 150;

export function scheduleHistoryEntryKey(entry: ScheduleHistoryEntry): string {
  return entry.type === "skipped"
    ? `skipped:${entry.recordedAt}`
    : `${entry.type}:${entry.occurrenceId}`;
}

export function mergeOlderScheduleHistory(input: {
  readonly currentOlder: readonly ScheduleHistoryEntry[];
  readonly page: readonly ScheduleHistoryEntry[];
  readonly recent: readonly ScheduleHistoryEntry[];
  readonly maximum?: number;
}): readonly ScheduleHistoryEntry[] {
  const available = Math.max(
    0,
    (input.maximum ?? MAX_VISIBLE_SCHEDULE_HISTORY) - input.recent.length,
  );
  const recentKeys = new Set(input.recent.map(scheduleHistoryEntryKey));
  const seen = new Set<string>();
  const older = [...input.page, ...input.currentOlder].filter((entry) => {
    const key = scheduleHistoryEntryKey(entry);
    if (recentKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return available === 0 ? [] : older.slice(-available);
}
