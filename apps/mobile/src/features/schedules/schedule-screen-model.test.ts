import {
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  type ScheduleHistoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildScheduleRows,
  canSelectScheduleWorkspaceMode,
  defaultScheduleWorkspaceMode,
  previewCronOccurrences,
  preferredScheduleBaseBranch,
  mergeOlderScheduleHistory,
  scheduleBaseBranch,
  getFrequentScheduleWarning,
  validateScheduleDraft,
  wallTimeInputForInstant,
  type MobileSchedule,
  type ScheduleEnvironment,
} from "./schedule-screen-model";

const environments: readonly ScheduleEnvironment[] = [
  {
    environmentId: "environment-online",
    label: "Online Mac",
    online: true,
    projects: [
      { projectId: "project-phoenix", title: "Phoenix", isGit: true },
      { projectId: "project-notes", title: "Notes", isGit: false },
    ],
  },
  {
    environmentId: "environment-offline",
    label: "Offline Linux",
    online: false,
    projects: [{ projectId: "project-api", title: "API", isGit: true }],
  },
];

function schedule(input: Partial<MobileSchedule> & Pick<MobileSchedule, "id" | "name">) {
  return {
    environmentId: "environment-online",
    projectId: ProjectId.make("project-phoenix"),
    state: "enabled",
    timing: { type: "cron", expression: "0 9 * * 1-5" },
    timeZone: "Europe/Berlin",
    execution: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "worktree",
      baseBranch: null,
    },
    nextOccurrenceAt: "2026-08-20T07:00:00.000Z",
    latestHistory: null,
    unacknowledgedFailure: false,
    createdAt: "2026-08-19T08:00:00.000Z",
    updatedAt: "2026-08-19T08:00:00.000Z",
    ...input,
    id: input.id,
    name: input.name,
    revision: input.revision ?? 0,
  } satisfies MobileSchedule;
}

describe("mobile Schedule presentation", () => {
  it("keeps cached offline Schedules visible and read-only while filtering failures", () => {
    const rows = buildScheduleRows({
      environments,
      schedules: [
        schedule({ id: ScheduleId.make("healthy"), name: "Healthy" }),
        schedule({
          id: ScheduleId.make("failed"),
          environmentId: "environment-offline",
          projectId: ProjectId.make("project-api"),
          name: "Nightly failure",
          state: "failed",
          unacknowledgedFailure: true,
        }),
      ],
      filters: {
        environmentId: null,
        projectId: null,
        state: null,
        failuresOnly: true,
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        scheduleId: "failed",
        environmentLabel: "Offline Linux",
        projectLabel: "API",
        offline: true,
        readOnly: true,
        hasFailureAttention: true,
      }),
    ]);
  });

  it("rejects missing fields, past one-time dates, and worktrees for non-Git projects", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    expect(
      validateScheduleDraft(
        {
          name: "",
          prompt: "",
          environmentId: "environment-online",
          projectId: "project-notes",
          timing: { type: "one-time", runAt: "2026-08-19T11:59:00.000Z" },
          timeZone: "Europe/Berlin",
          execution: {
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceMode: "worktree",
            baseBranch: null,
          },
          createPaused: false,
        },
        environments,
        now,
      ),
    ).toEqual({
      valid: false,
      errors: {
        name: "Enter a short name.",
        prompt: "Enter a prompt.",
        timing: "Choose a future time.",
        workspace: "Worktrees require a Git repository.",
      },
    });
  });

  it("defaults from confirmed Git capability and keeps local available while it is unknown", () => {
    expect(defaultScheduleWorkspaceMode(true)).toBe("worktree");
    expect(scheduleBaseBranch("worktree", "")).toBeNull();
    expect(defaultScheduleWorkspaceMode(false)).toBe("local");
    expect(defaultScheduleWorkspaceMode(null)).toBeNull();
    expect(scheduleBaseBranch("local", "ignored-branch")).toBeNull();
    expect(canSelectScheduleWorkspaceMode(true, "worktree")).toBe(true);
    expect(canSelectScheduleWorkspaceMode(false, "worktree")).toBe(false);
    expect(canSelectScheduleWorkspaceMode(null, "worktree")).toBe(false);
    expect(canSelectScheduleWorkspaceMode(true, "local")).toBe(true);
    expect(canSelectScheduleWorkspaceMode(false, "local")).toBe(true);
    expect(canSelectScheduleWorkspaceMode(null, "local")).toBe(true);
  });

  it("prefers the configured default ref and falls back to a remote-less Git checkout", () => {
    expect(
      preferredScheduleBaseBranch([
        { name: "main", current: true, isDefault: true, isRemote: false },
        { name: "origin/main", current: false, isDefault: true, isRemote: true },
      ]),
    ).toBe("origin/main");
    expect(
      preferredScheduleBaseBranch([
        { name: "main", current: true, isDefault: false, isRemote: false },
      ]),
    ).toBe("main");
    expect(preferredScheduleBaseBranch([])).toBeNull();
  });

  it("permits local saves while Git capability is unknown but keeps worktrees unavailable", () => {
    const draft = {
      name: "Review",
      prompt: "Review work",
      environmentId: "environment-online",
      projectId: "project-phoenix",
      timing: { type: "one-time" as const, runAt: "2026-08-20T12:00:00.000Z" },
      timeZone: "Europe/Berlin",
      execution: {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        workspaceMode: "local" as const,
        baseBranch: null,
      },
      createPaused: false,
    };
    const unknown = environments.map((environment) => ({
      ...environment,
      projects: environment.projects.map((project) =>
        project.projectId === "project-phoenix" ? { ...project, isGit: null } : project,
      ),
    }));
    expect(validateScheduleDraft(draft, unknown, new Date("2026-08-19T12:00:00.000Z"))).toEqual({
      valid: true,
      errors: {},
    });
    expect(
      validateScheduleDraft(
        {
          ...draft,
          execution: {
            ...draft.execution,
            workspaceMode: "worktree",
            baseBranch: "origin/main",
          },
        },
        unknown,
        new Date("2026-08-19T12:00:00.000Z"),
      ).errors.workspace,
    ).toBe("Worktrees are unavailable until Git status is known.");
    expect(
      validateScheduleDraft(
        {
          ...draft,
          execution: { ...draft.execution, workspaceMode: "worktree" },
        },
        environments,
        new Date("2026-08-19T12:00:00.000Z"),
      ).errors.workspace,
    ).toBe("Choose a base branch before saving a worktree Schedule.");
  });

  it("rejects invalid and sub-five-minute recurring rules", () => {
    const base = {
      name: "Watch CI",
      prompt: "Check CI",
      environmentId: "environment-online",
      projectId: "project-phoenix",
      execution: {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        workspaceMode: "worktree" as const,
        baseBranch: null,
      },
      createPaused: false,
    };

    expect(
      validateScheduleDraft(
        {
          ...base,
          timing: { type: "cron", expression: "not cron" },
          timeZone: "Europe/Berlin",
        },
        environments,
        new Date("2026-08-19T12:00:00.000Z"),
      ).errors.timing,
    ).toBe("Enter a valid five-field cron rule.");
    expect(
      validateScheduleDraft(
        {
          ...base,
          timing: { type: "cron", expression: "*/2 * * * *" },
          timeZone: "Europe/Berlin",
        },
        environments,
        new Date("2026-08-19T12:00:00.000Z"),
      ).errors.timing,
    ).toBe("Recurring Schedules must be at least five minutes apart.");
  });

  it("rejects an invalid IANA time zone for one-time Schedules", () => {
    const result = validateScheduleDraft(
      {
        name: "Review",
        prompt: "Review work",
        environmentId: "environment-online",
        projectId: "project-phoenix",
        timing: { type: "one-time", runAt: "2026-08-20T12:00:00.000Z" },
        timeZone: "Mars/Olympus",
        execution: {
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceMode: "worktree",
          baseBranch: "origin/HEAD",
        },
        createPaused: false,
      },
      environments,
      new Date("2026-08-19T12:00:00.000Z"),
    );

    expect(result.errors.timeZone).toBe("Choose a valid time zone.");
  });

  it("presents a one-time instant as local wall time in the saved time zone", () => {
    expect(wallTimeInputForInstant("2026-08-20T07:30:00.000Z", "Europe/Berlin")).toBe(
      "2026-08-20T09:30",
    );
    expect(wallTimeInputForInstant("2026-08-20T07:30:00.000Z", "Mars/Olympus")).toBeNull();
  });

  it("warns about the durable Thread volume of a five-minute Schedule", () => {
    expect(getFrequentScheduleWarning("*/5 * * * *")).toBe(
      "Every 5 minutes can create 288 Threads per day (about 105,000 per year). Phoenix does not automatically delete those Threads or their worktrees.",
    );
    expect(getFrequentScheduleWarning("0 9 * * 1-5")).toBeNull();
  });

  it("previews three zoned Occurrences while skipping a nonexistent DST wall time", () => {
    expect(
      previewCronOccurrences("30 2 * * *", "Europe/Berlin", new Date("2024-03-29T23:00:00.000Z")),
    ).toEqual(["2024-03-30T01:30:00.000Z", "2024-04-01T00:30:00.000Z", "2024-04-02T00:30:00.000Z"]);
  });

  it("prepends unique older history while keeping the rendered window bounded", () => {
    const skipped = (recordedAt: string): ScheduleHistoryEntry => ({
      type: "skipped",
      count: 1,
      countIsLowerBound: false,
      firstScheduledFor: recordedAt,
      lastScheduledFor: recordedAt,
      recordedAt,
    });
    const page = [skipped("2026-08-01T00:00:00.000Z"), skipped("2026-08-02T00:00:00.000Z")];
    const existing = [skipped("2026-08-02T00:00:00.000Z"), skipped("2026-08-03T00:00:00.000Z")];
    const recent = [skipped("2026-08-04T00:00:00.000Z")];

    expect(
      mergeOlderScheduleHistory({ currentOlder: existing, page, recent, maximum: 3 }).map(
        (entry) => entry.type === "skipped" && entry.recordedAt,
      ),
    ).toEqual(["2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z"]);
  });
});
