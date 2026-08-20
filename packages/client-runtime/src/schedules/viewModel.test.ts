import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateSchedules,
  filterScheduleRows,
  reconcileEnvironmentSchedules,
  scheduleMutationCapability,
  unacknowledgedScheduleFailureCount,
  type EnvironmentScheduleView,
  type ScheduleFilters,
} from "./viewModel.ts";

function schedule(
  overrides: Partial<EnvironmentScheduleView["schedules"][number]> = {},
): EnvironmentScheduleView["schedules"][number] {
  return {
    id: "schedule-1" as EnvironmentScheduleView["schedules"][number]["id"],
    projectId: "project-1" as EnvironmentScheduleView["schedules"][number]["projectId"],
    name: "Daily review",
    timing: { type: "cron", expression: "0 9 * * *" },
    timeZone: "Europe/Berlin",
    execution: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "worktree",
      baseBranch: "origin/HEAD",
    },
    state: "enabled",
    nextOccurrenceAt: "2026-08-20T07:00:00.000Z",
    latestHistory: null,
    unacknowledgedFailure: false,
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

function environment(overrides: Partial<EnvironmentScheduleView> = {}): EnvironmentScheduleView {
  return {
    environmentId: "environment-1" as EnvironmentScheduleView["environmentId"],
    environmentLabel: "Studio Mac",
    source: "live",
    online: true,
    supportsSchedules: true,
    snapshotSequence: 1,
    schedules: [schedule()],
    ...overrides,
  };
}

describe("Schedule aggregation", () => {
  it("keeps cached offline environments visible while a live snapshot supersedes cache", () => {
    const cached = environment({
      source: "cache",
      online: false,
      schedules: [schedule({ name: "Cached name" })],
    });
    const live = environment({
      source: "live",
      online: true,
      snapshotSequence: 2,
      schedules: [schedule({ name: "Live name", revision: 8 })],
    });
    const remote = environment({
      environmentId: "environment-2" as EnvironmentScheduleView["environmentId"],
      environmentLabel: "Build server",
      source: "cache",
      online: false,
      schedules: [
        schedule({
          id: "schedule-2" as EnvironmentScheduleView["schedules"][number]["id"],
          name: "Nightly checks",
          revision: 3,
        }),
      ],
    });

    expect(reconcileEnvironmentSchedules(cached, live)).toBe(live);
    expect(aggregateSchedules([live, remote])).toEqual([
      expect.objectContaining({
        name: "Live name",
        environmentLabel: "Studio Mac",
        online: true,
        revision: 8,
      }),
      expect.objectContaining({
        name: "Nightly checks",
        environmentLabel: "Build server",
        online: false,
        revision: 3,
      }),
    ]);
  });

  it("filters by environment, project, lifecycle state and failure presence", () => {
    const rows = aggregateSchedules([
      environment({
        schedules: [
          schedule(),
          schedule({
            id: "schedule-2" as EnvironmentScheduleView["schedules"][number]["id"],
            projectId: "project-2" as EnvironmentScheduleView["schedules"][number]["projectId"],
            state: "failed",
            unacknowledgedFailure: true,
          }),
        ],
      }),
    ]);
    const filters: ScheduleFilters = {
      environmentIds: new Set([environment().environmentId]),
      projectIds: new Set([
        "project-2" as EnvironmentScheduleView["schedules"][number]["projectId"],
      ]),
      states: new Set(["failed"]),
      failures: "only",
    };

    expect(filterScheduleRows(rows, filters).map((row) => row.id)).toEqual(["schedule-2"]);
  });

  it("counts only unacknowledged pre-Trigger failures", () => {
    const rows = aggregateSchedules([
      environment({
        schedules: [
          schedule({ unacknowledgedFailure: true }),
          schedule({
            id: "schedule-2" as EnvironmentScheduleView["schedules"][number]["id"],
            state: "failed",
            unacknowledgedFailure: false,
          }),
        ],
      }),
    ]);

    expect(unacknowledgedScheduleFailureCount(rows)).toBe(1);
  });

  it("keeps acknowledged historical failures available to the failure filter", () => {
    const rows = aggregateSchedules([
      environment({
        schedules: [
          schedule({
            state: "failed",
            unacknowledgedFailure: false,
          }),
        ],
      }),
    ]);

    expect(
      filterScheduleRows(rows, {
        environmentIds: new Set(),
        projectIds: new Set(),
        states: new Set(),
        failures: "only",
      }),
    ).toHaveLength(1);
    expect(unacknowledgedScheduleFailureCount(rows)).toBe(0);
  });
});

describe("Schedule mutation capability", () => {
  it("makes cached offline and unsupported environments read-only", () => {
    expect(scheduleMutationCapability(environment({ online: false }))).toEqual({
      allowed: false,
      reason: "Connect Studio Mac to make changes.",
    });
    expect(scheduleMutationCapability(environment({ supportsSchedules: false }))).toEqual({
      allowed: false,
      reason: "Studio Mac must be updated before it can manage Schedules.",
    });
    expect(scheduleMutationCapability(environment())).toEqual({ allowed: true, reason: null });
  });
});
