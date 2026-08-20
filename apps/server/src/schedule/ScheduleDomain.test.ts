import {
  CommandId,
  OccurrenceId,
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
  type ScheduleDomainEvent,
  type ScheduleStoredDefinition,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  decideInvalidTimingFailure,
  decideOccurrenceOutcome,
  decideSchedule,
  decideScheduledOccurrenceReservation,
  evolveScheduleDefinition,
  type ScheduleLifecycleDecision,
} from "./ScheduleDomain.ts";

const current = {
  id: ScheduleId.make("daily-review"),
  projectId: ProjectId.make("phoenix"),
  name: "Daily review",
  prompt: "Review the project",
  timing: { type: "one-time", runAt: "2026-08-20T09:00:00.000Z" },
  timeZone: "Europe/Berlin",
  execution: {
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceMode: "local",
    baseBranch: null,
  },
  state: "completed",
  nextOccurrenceAt: null,
  latestHistory: null,
  unacknowledgedFailure: false,
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T09:00:00.000Z",
} satisfies ScheduleStoredDefinition;

const occurrenceId = OccurrenceId.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const nextOccurrenceId = OccurrenceId.make("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

function projectLifecycle(
  definition: ScheduleStoredDefinition,
  decision: ScheduleLifecycleDecision,
): ScheduleStoredDefinition {
  const projected = decision.events.reduce<ScheduleStoredDefinition | null>(
    (detail, event: ScheduleDomainEvent) => evolveScheduleDefinition(detail, event),
    definition,
  );
  assert.isNotNull(projected);
  return projected;
}

describe("ScheduleDomain", () => {
  it("preserves terminal state when editing an unchanged one-time occurrence", () => {
    const decision = decideSchedule({
      current,
      command: {
        type: "schedule.update",
        commandId: CommandId.make("edit-daily-review"),
        scheduleId: current.id,
        projectId: current.projectId,
        name: "Daily review edited",
        prompt: current.prompt,
        timing: current.timing,
        timeZone: current.timeZone,
        execution: current.execution,
      },
      facts: { at: "2026-08-20T10:00:00.000Z", nextOccurrenceAt: null },
    });

    assert.isTrue(decision.ok);
    if (!decision.ok || decision.detail === null) return;
    assert.strictEqual(decision.event.type, "schedule.updated");
    assert.strictEqual(decision.detail.state, "completed");
    assert.isNull(decision.detail.nextOccurrenceAt);
    assert.strictEqual(decision.detail.name, "Daily review edited");
  });

  it("rejects a stale pause after a one-time Schedule becomes terminal", () => {
    const decision = decideSchedule({
      current,
      command: {
        type: "schedule.pause",
        commandId: CommandId.make("pause-daily-review"),
        scheduleId: current.id,
      },
      facts: { at: "2026-08-20T10:00:00.000Z" },
    });

    assert.isFalse(decision.ok);
    if (decision.ok) return;
    assert.strictEqual(decision.error.failure, "invalid_state");
  });

  it("re-enables a terminal Schedule when its one-time occurrence changes", () => {
    const nextOccurrenceAt = "2026-08-21T09:00:00.000Z";
    const decision = decideSchedule({
      current,
      command: {
        type: "schedule.update",
        commandId: CommandId.make("reschedule-daily-review"),
        scheduleId: current.id,
        projectId: current.projectId,
        name: current.name,
        prompt: current.prompt,
        timing: { type: "one-time", runAt: nextOccurrenceAt },
        timeZone: current.timeZone,
        execution: current.execution,
      },
      facts: { at: "2026-08-20T10:00:00.000Z", nextOccurrenceAt },
    });

    assert.isTrue(decision.ok);
    if (!decision.ok || decision.detail === null) return;
    assert.strictEqual(decision.detail.state, "enabled");
    assert.strictEqual(decision.detail.nextOccurrenceAt, nextOccurrenceAt);
  });

  it("decides skipped history and reservation events together", () => {
    const recurring = {
      ...current,
      timing: { type: "cron", expression: "*/5 * * * *" },
      state: "enabled",
      nextOccurrenceAt: "2026-08-20T09:00:00.000Z",
    } satisfies ScheduleStoredDefinition;
    const decision = decideScheduledOccurrenceReservation({
      occurrenceId,
      scheduledFor: "2026-08-20T10:00:00.000Z",
      nextOccurrenceAt: "2026-08-20T10:05:00.000Z",
      skipped: {
        count: 12,
        countIsLowerBound: false,
        firstScheduledFor: "2026-08-20T09:00:00.000Z",
        lastScheduledFor: "2026-08-20T09:55:00.000Z",
      },
      at: "2026-08-20T10:01:00.000Z",
    });

    assert.deepStrictEqual(
      decision.events.map(({ type }) => type),
      ["schedule.occurrences-skipped", "schedule.occurrence-reserved"],
    );
    assert.strictEqual(decision.history[0]?.entry.type, "skipped");
    assert.strictEqual(decision.occurrence.status, "pending");
    const projected = projectLifecycle(recurring, decision);
    assert.strictEqual(projected.latestHistory?.type, "skipped");
    assert.strictEqual(projected.nextOccurrenceAt, "2026-08-20T10:05:00.000Z");
  });

  it("decides invalid timing as a terminal failure", () => {
    const enabled = {
      ...current,
      state: "enabled",
      nextOccurrenceAt: "2026-08-20T09:00:00.000Z",
    } satisfies ScheduleStoredDefinition;
    const decision = decideInvalidTimingFailure({
      current: enabled,
      occurrenceId,
      at: "2026-08-20T10:00:00.000Z",
      cause: new Error("Saved cron is malformed"),
    });

    assert.strictEqual(decision.history[0]?.entry.type, "failed");
    assert.strictEqual(decision.occurrence.errorCode, "invalid_timing");
    assert.strictEqual(decision.occurrence.errorMessage, "Saved cron is malformed");
    const projected = projectLifecycle(enabled, decision);
    assert.strictEqual(projected.state, "failed");
    assert.isNull(projected.nextOccurrenceAt);
    assert.isTrue(projected.unacknowledgedFailure);
  });

  it("completes a scheduled one-time occurrence when Triggered", () => {
    const enabled = {
      ...current,
      state: "enabled",
      nextOccurrenceAt: null,
    } satisfies ScheduleStoredDefinition;
    const threadId = ThreadId.make("schedule:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const decision = decideOccurrenceOutcome({
      current: enabled,
      sourceDefinition: enabled,
      occurrenceId,
      scheduledFor: "2026-08-20T09:00:00.000Z",
      source: "scheduled",
      outcome: { type: "triggered", threadId },
      at: "2026-08-20T09:00:01.000Z",
    });

    assert.strictEqual(decision.events[0].type, "schedule.occurrence-triggered");
    assert.strictEqual(decision.occurrence.threadId, threadId);
    const projected = projectLifecycle(enabled, decision);
    assert.strictEqual(projected.state, "completed");
    assert.strictEqual(projected.latestHistory?.type, "triggered");
  });

  it("compacts repeated recurring Trigger failures without making the Schedule terminal", () => {
    const recurring = {
      ...current,
      timing: { type: "cron", expression: "*/5 * * * *" },
      state: "enabled",
      latestHistory: {
        type: "failed",
        occurrenceId,
        scheduledFor: "2026-08-20T09:00:00.000Z",
        failedAt: "2026-08-20T09:00:01.000Z",
        code: "provider_unavailable",
        message: "Provider unavailable",
        count: 2,
        firstFailedAt: "2026-08-20T08:55:01.000Z",
        lastFailedAt: "2026-08-20T09:00:01.000Z",
      },
      nextOccurrenceAt: "2026-08-20T09:10:00.000Z",
    } satisfies ScheduleStoredDefinition;
    const decision = decideOccurrenceOutcome({
      current: recurring,
      sourceDefinition: recurring,
      occurrenceId: nextOccurrenceId,
      scheduledFor: "2026-08-20T09:05:00.000Z",
      source: "scheduled",
      outcome: {
        type: "failed",
        threadId: null,
        code: "provider_unavailable",
        message: "Provider unavailable",
      },
      at: "2026-08-20T09:05:01.000Z",
    });

    assert.strictEqual(decision.history[0]?.type, "replace-latest");
    assert.strictEqual(decision.history[0]?.entry.type, "failed");
    if (decision.history[0]?.entry.type === "failed") {
      assert.strictEqual(decision.history[0].entry.count, 3);
      assert.strictEqual(decision.history[0].entry.firstFailedAt, "2026-08-20T08:55:01.000Z");
    }
    const projected = projectLifecycle(recurring, decision);
    assert.strictEqual(projected.state, "enabled");
    assert.isTrue(projected.unacknowledgedFailure);
  });
});
