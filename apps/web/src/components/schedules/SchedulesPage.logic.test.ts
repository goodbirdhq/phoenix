import {
  OccurrenceId,
  ProviderInstanceId,
  type ModelSelection,
  type ScheduleHistoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseScheduleModelSelection,
  latestScheduleHistoryListText,
  latestScheduleHistorySummary,
  prependOlderScheduleHistory,
  resolveScheduleBaseBranch,
  resolveScheduleWorkspaceModeDefault,
  scheduleFailureAttentionVersion,
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

  it("defaults non-repositories and unknown repositories to the local workspace", () => {
    expect(resolveScheduleWorkspaceModeDefault(true, "worktree")).toBe("worktree");
    expect(resolveScheduleWorkspaceModeDefault(true, "local")).toBe("local");
    expect(resolveScheduleWorkspaceModeDefault(false, "worktree")).toBe("local");
    expect(resolveScheduleWorkspaceModeDefault(null, "worktree")).toBe("local");
  });
});

describe("Schedule attention and history", () => {
  const failed = (occurrenceId: string): ScheduleHistoryEntry => ({
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
