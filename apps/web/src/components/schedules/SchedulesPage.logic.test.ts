import {
  OccurrenceId,
  ProviderInstanceId,
  type ModelSelection,
  type ScheduleHistoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseScheduleModelSelection,
  compareScheduleSidebarRows,
  schedulePromptExplanation,
  scheduleHistoryFailureDetails,
  scheduleDisplayTimestamp,
  scheduleRepeatSummary,
  latestScheduleHistoryListText,
  latestScheduleHistorySummary,
  prependOlderScheduleHistory,
  reconcileScheduleEditorDefaults,
  resolveScheduleBaseBranch,
  resolveScheduleWorkspaceModeDefault,
  schedulePauseFieldLabel,
  scheduleFailureAttentionVersion,
  shouldOpenScheduleCreateRequest,
  scheduleWorktreeCapability,
} from "./SchedulesPage.logic";

const configuredSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};

describe("Schedule editor logic", () => {
  it("preserves every option from the preferred explicit model selection", () => {
    const chosen = chooseScheduleModelSelection(
      [configuredSelection],
      [
        {
          selection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          isDefault: true,
        },
      ],
    );

    expect(chosen).toBe(configuredSelection);
  });

  it("prefers the configured default branch, then the current local branch", () => {
    expect(
      resolveScheduleBaseBranch([
        { name: "feature", current: true, isDefault: false, isRemote: false },
        { name: "origin/main", current: false, isDefault: true, isRemote: true },
      ]),
    ).toBe("origin/main");
    expect(
      resolveScheduleBaseBranch([
        { name: "main", current: true, isDefault: false, isRemote: undefined },
      ]),
    ).toBe("main");
  });

  it("enables worktrees only for an authoritative repository result", () => {
    expect(scheduleWorktreeCapability(null)).toEqual({
      allowed: false,
      pendingValidation: true,
    });
    expect(scheduleWorktreeCapability(false)).toEqual({
      allowed: false,
      pendingValidation: false,
    });
    expect(scheduleWorktreeCapability(true)).toEqual({
      allowed: true,
      pendingValidation: false,
    });
  });

  it("defaults confirmed Git projects to a worktree independently of thread preferences", () => {
    expect(resolveScheduleWorkspaceModeDefault(true)).toBe("worktree");
    expect(resolveScheduleWorkspaceModeDefault(false)).toBe("local");
    expect(resolveScheduleWorkspaceModeDefault(null)).toBe("local");
  });

  it("settles editor defaults without overwriting a newly selected Environment", () => {
    const empty = {
      environmentId: "agents",
      projectId: "",
      modelSelection: null,
      workspaceMode: "local" as const,
      workspaceCustomized: false,
      baseBranch: "origin/HEAD",
    };
    const noData = {
      environmentId: "agents",
      projects: [],
      modelChoices: [],
      serverDefaultModelSelection: null,
      isRepo: null,
      branchRefs: [],
      editing: false,
    };

    expect(reconcileScheduleEditorDefaults(empty, noData)).toBe(empty);

    const withProject = reconcileScheduleEditorDefaults(empty, {
      ...noData,
      projects: [
        { id: "project-1", defaultModelSelection: null, defaultThreadEnvMode: "local" as const },
      ],
    });
    expect(withProject).toMatchObject({
      environmentId: "agents",
      projectId: "project-1",
      workspaceMode: "local",
    });

    const repositoryConfirmed = reconcileScheduleEditorDefaults(withProject, {
      ...noData,
      projects: [
        { id: "project-1", defaultModelSelection: null, defaultThreadEnvMode: "local" as const },
      ],
      isRepo: true,
      branchRefs: [{ name: "origin/main", current: false, isDefault: true, isRemote: true }],
    });
    expect(repositoryConfirmed).toMatchObject({
      environmentId: "agents",
      workspaceMode: "worktree",
      baseBranch: "origin/main",
    });
    expect(
      reconcileScheduleEditorDefaults(repositoryConfirmed, {
        ...noData,
        projects: [
          { id: "project-1", defaultModelSelection: null, defaultThreadEnvMode: "local" as const },
        ],
        isRepo: true,
        branchRefs: [{ name: "origin/main", current: false, isDefault: true, isRemote: true }],
      }),
    ).toBe(repositoryConfirmed);
  });

  it("retains an explicit shared-workspace override after Git is confirmed", () => {
    const draft = {
      environmentId: "agents",
      projectId: "project-1",
      modelSelection: null,
      workspaceMode: "local" as const,
      workspaceCustomized: true,
      baseBranch: "origin/HEAD",
    };

    expect(
      reconcileScheduleEditorDefaults(draft, {
        environmentId: "agents",
        projects: [{ id: "project-1", defaultModelSelection: null }],
        modelChoices: [],
        serverDefaultModelSelection: null,
        isRepo: true,
        branchRefs: [],
        editing: false,
      }),
    ).toBe(draft);
  });

  it("preserves saved project and provider when editing an unavailable configuration", () => {
    const draft = {
      environmentId: "agents",
      projectId: "removed-project",
      modelSelection: configuredSelection,
      workspaceMode: "local" as const,
      workspaceCustomized: true,
      baseBranch: "origin/main",
    };
    expect(
      reconcileScheduleEditorDefaults(draft, {
        environmentId: "agents",
        projects: [{ id: "other-project", defaultModelSelection: null }],
        modelChoices: [
          {
            selection: { instanceId: ProviderInstanceId.make("claude"), model: "another-model" },
            isDefault: true,
          },
        ],
        serverDefaultModelSelection: null,
        isRepo: false,
        branchRefs: [],
        editing: true,
      }),
    ).toBe(draft);
  });

  it("uses mode-appropriate pause copy", () => {
    expect(schedulePauseFieldLabel(false)).toBe("Create Paused");
    expect(schedulePauseFieldLabel(true)).toBeNull();
  });

  it("opens Create again when a new command-palette request arrives on the same route", () => {
    expect(shouldOpenScheduleCreateRequest(null, "first-request")).toBe(true);
    expect(shouldOpenScheduleCreateRequest("first-request", "first-request")).toBe(false);
    expect(shouldOpenScheduleCreateRequest("first-request", "second-request")).toBe(true);
  });
});

describe("Schedule attention and history", () => {
  const failed = (occurrenceId: string): Extract<ScheduleHistoryEntry, { type: "failed" }> => ({
    type: "failed",
    occurrenceId: OccurrenceId.make(occurrenceId),
    scheduledFor: "2026-08-19T09:00:00.000Z",
    failedAt: "2026-08-19T09:00:01.000Z",
    code: "trigger_failed",
    message: "Could not create the worktree",
    count: 2,
    firstFailedAt: "2026-08-19T09:00:01.000Z",
    lastFailedAt: "2026-08-19T09:05:01.000Z",
  });

  it("preserves failure codes and actual retry times in the owning time zone", () => {
    const entry = {
      ...failed("00000000-0000-0000-0000-00000000000a"),
      scheduledFor: "2026-08-19T07:00:00.000Z",
      firstFailedAt: "2026-08-19T07:20:00.000Z",
      lastFailedAt: "2026-08-19T07:40:00.000Z",
    };
    const details = scheduleHistoryFailureDetails(entry, "Europe/Berlin");
    expect(details).toContain("trigger_failed");
    expect(details).toContain("09:20");
    expect(details).toContain("09:40");
    expect(details).not.toContain("09:00");
    expect(
      scheduleHistoryFailureDetails(
        { ...entry, lastFailedAt: entry.firstFailedAt },
        "Europe/Berlin",
      ),
    ).not.toContain(" – ");
    expect(
      scheduleHistoryFailureDetails(
        { ...entry, lastFailedAt: "2026-08-20T07:40:00.000Z" },
        "Europe/Berlin",
      ),
    ).toContain("20 Aug");
  });

  it("keys acknowledgement to the latest failed Occurrence", () => {
    expect(
      scheduleFailureAttentionVersion(
        true,
        failed("00000000-0000-0000-0000-00000000000a"),
        "updated-a",
      ),
    ).toBe("failed:00000000-0000-0000-0000-00000000000a");
    expect(
      scheduleFailureAttentionVersion(
        true,
        failed("00000000-0000-0000-0000-00000000000b"),
        "updated-b",
      ),
    ).toBe("failed:00000000-0000-0000-0000-00000000000b");
    expect(
      scheduleFailureAttentionVersion(
        false,
        failed("00000000-0000-0000-0000-00000000000b"),
        "updated-b",
      ),
    ).toBeNull();
  });

  it("describes the latest Trigger, failure, and compact skipped range", () => {
    expect(latestScheduleHistorySummary(failed("00000000-0000-0000-0000-00000000000a"))).toEqual({
      label: "Failed twice",
      detail: "Could not create the worktree",
      at: "2026-08-19T09:05:01.000Z",
    });
    expect(
      latestScheduleHistorySummary({
        type: "skipped",
        count: 10_000,
        countIsLowerBound: true,
        firstScheduledFor: "2026-01-01T00:00:00.000Z",
        lastScheduledFor: "2026-08-19T09:00:00.000Z",
        recordedAt: "2026-08-19T09:00:01.000Z",
      }),
    ).toEqual({
      label: "Skipped at least 10,000 Occurrences",
      detail: "2026-01-01T00:00:00.000Z – 2026-08-19T09:00:00.000Z",
      at: "2026-08-19T09:00:01.000Z",
    });
  });

  it("formats list dates through the Schedule time-zone formatter", () => {
    expect(
      latestScheduleHistoryListText(
        {
          type: "triggered",
          occurrenceId: OccurrenceId.make("00000000-0000-0000-0000-00000000000c"),
          scheduledFor: "2026-08-19T09:00:00.000Z",
          triggeredAt: "2026-08-19T09:00:01.000Z",
          threadId: "thread-1" as never,
        },
        (value) => `Berlin(${value})`,
      ),
    ).toBe("Triggered · Berlin(2026-08-19T09:00:01.000Z)");
  });

  it("prepends older pages, removes boundary duplicates, and caps rendered history", () => {
    const skipped = (recordedAt: string): ScheduleHistoryEntry => ({
      type: "skipped",
      count: 1,
      countIsLowerBound: false,
      firstScheduledFor: recordedAt,
      lastScheduledFor: recordedAt,
      recordedAt,
    });
    const first = skipped("2026-08-19T09:00:01.000Z");
    const second = skipped("2026-08-19T09:05:01.000Z");
    const third = skipped("2026-08-19T09:10:01.000Z");
    const fourth = skipped("2026-08-19T09:15:01.000Z");

    expect(prependOlderScheduleHistory([second, third], [third, fourth], 4)).toEqual([
      second,
      third,
      fourth,
    ]);
    expect(prependOlderScheduleHistory([first, second], [third, fourth], 3)).toEqual([
      first,
      second,
      third,
    ]);
  });
});

describe("schedule destination labels", () => {
  it("formats in the owning environment time zone across midnight and daylight saving", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    expect(scheduleDisplayTimestamp("2026-09-07T07:00:00Z", "Europe/Berlin", now)).toBe(
      "Mon, 7 Sep · 09:00",
    );
    expect(scheduleDisplayTimestamp("2026-09-07T23:30:00Z", "Europe/Berlin", now)).toBe(
      "Tue, 8 Sep · 01:30",
    );
    expect(scheduleDisplayTimestamp("2026-12-07T07:00:00Z", "Europe/Berlin", now)).toBe(
      "Mon, 7 Dec · 08:00",
    );
    expect(scheduleDisplayTimestamp("2025-09-07T07:00:00Z", "Europe/Berlin", now)).toBe(
      "Sun, 7 Sep 2025 · 09:00",
    );
    expect(scheduleDisplayTimestamp("unavailable", "Europe/Berlin", now)).toBe("unavailable");
  });
  it("separates a known cadence from its time without guessing custom cron semantics", () => {
    expect(
      scheduleRepeatSummary({ type: "cron", expression: "0 9 * * 1-5" }, "Europe/Berlin"),
    ).toEqual({ value: "Weekdays", description: "At 09:00 · Mon–Fri" });
    expect(
      scheduleRepeatSummary({ type: "cron", expression: "*/16 * * * *" }, "Europe/Berlin"),
    ).toEqual({ value: "*/16 * * * *", description: "*/16 * * * *" });
  });
});

describe("schedule navigation and recovery", () => {
  it("sorts enabled schedules by upcoming time across environments, then offline rows", () => {
    const rows = [
      {
        state: "enabled" as const,
        online: false,
        nextOccurrenceAt: "2026-09-08T05:00:00Z",
        name: "Offline",
      },
      { state: "enabled" as const, online: true, nextOccurrenceAt: null, name: "Unavailable" },
      {
        state: "enabled" as const,
        online: true,
        nextOccurrenceAt: "2026-09-08T07:00:00Z",
        name: "Daily",
      },
      {
        state: "enabled" as const,
        online: true,
        nextOccurrenceAt: "2026-09-08T06:00:00Z",
        name: "Dependency",
      },
    ];
    expect(rows.toSorted(compareScheduleSidebarRows).map((row) => row.name)).toEqual([
      "Dependency",
      "Daily",
      "Unavailable",
      "Offline",
    ]);
  });
  it("recognizes a successful manual recovery while the one-time schedule remains failed", () => {
    expect(schedulePromptExplanation("failed", "triggered")).toContain(
      "latest run created a thread",
    );
    expect(schedulePromptExplanation("failed", "failed")).toContain("could not start its thread");
    expect(schedulePromptExplanation("completed", null)).not.toContain("thread was created");
  });
});
