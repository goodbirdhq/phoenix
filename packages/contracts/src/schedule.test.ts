import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  OccurrenceId,
  ScheduleCommand,
  ScheduleDetail,
  ScheduleDomainEvent,
  ScheduleGetHistoryInput,
  ScheduleHistoryPage,
  ScheduleId,
  ScheduleListStreamEvent,
  evolveScheduleDefinition,
} from "./schedule.ts";

const execution = {
  modelSelection: { instanceId: "codex", model: "gpt-5.6-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceMode: "worktree" as const,
  baseBranch: "main",
};
const decodeScheduleDetail = Schema.decodeUnknownSync(ScheduleDetail);
const decodeScheduleCommand = Schema.decodeUnknownSync(ScheduleCommand);
const decodeScheduleListStreamEvent = Schema.decodeUnknownSync(ScheduleListStreamEvent);
const decodeScheduleGetHistoryInput = Schema.decodeUnknownSync(ScheduleGetHistoryInput);
const decodeScheduleHistoryPage = Schema.decodeUnknownSync(ScheduleHistoryPage);
const decodeScheduleDomainEvent = Schema.decodeUnknownSync(ScheduleDomainEvent);

describe("Schedule contracts", () => {
  it("decodes an explicit one-time Schedule detail with Triggered history", () => {
    const decoded = decodeScheduleDetail({
      id: "schedule-1",
      projectId: "project-1",
      name: "Morning check",
      prompt: "Check the deployment.",
      timing: { type: "one-time", runAt: "2026-08-20T08:00:00.000Z" },
      timeZone: "Europe/Berlin",
      execution,
      state: "completed",
      nextOccurrenceAt: null,
      latestHistory: {
        type: "triggered",
        occurrenceId: "018fd1b2-6610-7e39-8f09-468fa24c8c01",
        scheduledFor: "2026-08-20T08:00:00.000Z",
        triggeredAt: "2026-08-20T08:00:01.000Z",
        threadId: "thread-1",
      },
      unacknowledgedFailure: false,
      createdAt: "2026-08-19T08:00:00.000Z",
      updatedAt: "2026-08-20T08:00:01.000Z",
      history: [
        {
          type: "triggered",
          occurrenceId: "018fd1b2-6610-7e39-8f09-468fa24c8c01",
          scheduledFor: "2026-08-20T08:00:00.000Z",
          triggeredAt: "2026-08-20T08:00:01.000Z",
          threadId: "thread-1",
        },
      ],
      historyNextCursor: "41",
    });

    expect(decoded.id).toBe(ScheduleId.make("schedule-1"));
    expect(decoded.revision).toBe(0);
    const firstHistory = decoded.history[0];
    expect(firstHistory?.type).toBe("triggered");
    if (firstHistory?.type === "triggered") {
      expect(firstHistory.occurrenceId).toBe(
        OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c01"),
      );
    }
  });

  it("decodes bounded history pages and rejects excessive limits", () => {
    expect(
      decodeScheduleHistoryPage({
        scheduleId: "schedule-1",
        entries: [],
        nextCursor: null,
      }),
    ).toEqual({
      scheduleId: ScheduleId.make("schedule-1"),
      entries: [],
      nextCursor: null,
    });
    expect(
      decodeScheduleGetHistoryInput({
        scheduleId: "schedule-1",
        cursor: "41",
        limit: 100,
      }),
    ).toMatchObject({ cursor: "41", limit: 100 });
    expect(() => decodeScheduleGetHistoryInput({ scheduleId: "schedule-1", limit: 101 })).toThrow();
    expect(() =>
      decodeScheduleGetHistoryInput({
        scheduleId: "schedule-1",
        cursor: "999999999999999999999999999999999999",
      }),
    ).toThrow();
  });

  it("requires Run now callers to reserve a stable Occurrence identity", () => {
    const decoded = decodeScheduleCommand({
      type: "schedule.run-now",
      commandId: "command-1",
      scheduleId: "schedule-1",
      occurrenceId: "018fd1b2-6610-7e39-8f09-468fa24c8c01",
    });

    expect(decoded.type).toBe("schedule.run-now");
    if (decoded.type === "schedule.run-now") {
      expect(decoded.occurrenceId).toBe(OccurrenceId.make("018fd1b2-6610-7e39-8f09-468fa24c8c01"));
    }
  });

  it("keeps Schedule subscription traffic outside the orchestration shell shape", () => {
    const decoded = decodeScheduleListStreamEvent({
      type: "schedule-removed",
      sequence: 3,
      scheduleId: "schedule-1",
    });

    expect(decoded).toEqual({
      type: "schedule-removed",
      sequence: 3,
      scheduleId: ScheduleId.make("schedule-1"),
    });
  });

  it("rebuilds the stored definition by replaying typed domain events", () => {
    const createdAt = "2026-08-19T08:00:00.000Z";
    const definition = {
      id: ScheduleId.make("schedule-replay"),
      projectId: "project-1",
      name: "Replay me",
      prompt: "Check replay behavior.",
      timing: { type: "cron" as const, expression: "*/5 * * * *" },
      timeZone: "UTC",
      execution,
      state: "enabled" as const,
      nextOccurrenceAt: "2026-08-19T08:05:00.000Z",
      latestHistory: null,
      unacknowledgedFailure: false,
      createdAt,
      updatedAt: createdAt,
    };
    const created = decodeScheduleDomainEvent({
      type: "schedule.created",
      command: {
        type: "schedule.create",
        commandId: "create-replay",
        scheduleId: "schedule-replay",
        projectId: "project-1",
        name: "Replay me",
        prompt: "Check replay behavior.",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution,
        state: "enabled",
      },
      definition,
    });
    const paused = decodeScheduleDomainEvent({
      type: "schedule.paused",
      command: {
        type: "schedule.pause",
        commandId: "pause-replay",
        scheduleId: "schedule-replay",
      },
      updatedAt: "2026-08-19T08:01:00.000Z",
    });

    const rebuilt = [created, paused].reduce(evolveScheduleDefinition, null);
    expect(rebuilt?.state).toBe("paused");
    expect(rebuilt?.nextOccurrenceAt).toBeNull();
    expect(rebuilt?.prompt).toBe("Check replay behavior.");
  });
});
