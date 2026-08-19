import type { EnvironmentId, ProjectId, ScheduleState, ScheduleSummary } from "@t3tools/contracts";

export interface EnvironmentScheduleView {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly source: "cache" | "live";
  readonly online: boolean;
  readonly supportsSchedules: boolean;
  readonly snapshotSequence: number;
  readonly schedules: ReadonlyArray<ScheduleSummary>;
}

export interface AggregatedScheduleRow extends ScheduleSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly source: "cache" | "live";
  readonly online: boolean;
  readonly supportsSchedules: boolean;
}

export interface ScheduleFilters {
  readonly environmentIds: ReadonlySet<EnvironmentId>;
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly states: ReadonlySet<ScheduleState>;
  readonly failures: "all" | "only" | "without";
}

export interface ScheduleMutationCapability {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/** A live server projection is authoritative even when an old cache has a larger local cursor. */
export function reconcileEnvironmentSchedules(
  cached: EnvironmentScheduleView | null,
  live: EnvironmentScheduleView | null,
): EnvironmentScheduleView | null {
  return live ?? cached;
}

export function aggregateSchedules(
  environments: ReadonlyArray<EnvironmentScheduleView>,
): ReadonlyArray<AggregatedScheduleRow> {
  return environments.flatMap((environment) =>
    environment.schedules.map((schedule) => ({
      ...schedule,
      environmentId: environment.environmentId,
      environmentLabel: environment.environmentLabel,
      source: environment.source,
      online: environment.online,
      supportsSchedules: environment.supportsSchedules,
    })),
  );
}

function acceptsSet<T>(values: ReadonlySet<T>, value: T): boolean {
  return values.size === 0 || values.has(value);
}

export function filterScheduleRows(
  rows: ReadonlyArray<AggregatedScheduleRow>,
  filters: ScheduleFilters,
): ReadonlyArray<AggregatedScheduleRow> {
  return rows.filter(
    (row) =>
      acceptsSet(filters.environmentIds, row.environmentId) &&
      acceptsSet(filters.projectIds, row.projectId) &&
      acceptsSet(filters.states, row.state) &&
      (filters.failures === "all" ||
        (filters.failures === "only" && scheduleHasFailure(row)) ||
        (filters.failures === "without" && !scheduleHasFailure(row))),
  );
}

export function scheduleHasFailure(
  schedule: Pick<ScheduleSummary, "latestHistory" | "state" | "unacknowledgedFailure">,
): boolean {
  return (
    schedule.unacknowledgedFailure ||
    schedule.state === "failed" ||
    schedule.latestHistory?.type === "failed"
  );
}

export function scheduleMutationCapability(
  environment: Pick<EnvironmentScheduleView, "environmentLabel" | "online" | "supportsSchedules">,
): ScheduleMutationCapability {
  if (!environment.supportsSchedules) {
    return {
      allowed: false,
      reason: `${environment.environmentLabel} must be updated before it can manage Schedules.`,
    };
  }
  if (!environment.online) {
    return {
      allowed: false,
      reason: `Connect ${environment.environmentLabel} to make changes.`,
    };
  }
  return { allowed: true, reason: null };
}

export function unacknowledgedScheduleFailureCount(
  rows: ReadonlyArray<Pick<ScheduleSummary, "unacknowledgedFailure">>,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.unacknowledgedFailure) count += 1;
  }
  return count;
}
