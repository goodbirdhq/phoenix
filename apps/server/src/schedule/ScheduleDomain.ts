import type {
  OccurrenceId,
  ScheduleCommand,
  ScheduleDomainEvent,
  ScheduleHistoryEntry,
  ScheduleOperationFailure,
  ScheduleStoredDefinition,
  ThreadId,
} from "@t3tools/contracts";

export function evolveScheduleDefinition(
  current: ScheduleStoredDefinition | null,
  event: ScheduleDomainEvent,
): ScheduleStoredDefinition | null {
  if (event.type === "schedule.created" || event.type === "schedule.rebased") {
    return event.definition;
  }
  if (event.type === "schedule.deleted") return null;
  if (current === null) throw new Error(`Cannot apply ${event.type} before schedule.created`);
  switch (event.type) {
    case "schedule.updated":
      return {
        ...current,
        projectId: event.command.projectId,
        name: event.command.name,
        prompt: event.command.prompt,
        timing: event.command.timing,
        timeZone: event.command.timeZone,
        execution: event.command.execution,
        state: event.state,
        nextOccurrenceAt: event.nextOccurrenceAt,
        updatedAt: event.updatedAt,
      };
    case "schedule.paused":
      return { ...current, state: "paused", nextOccurrenceAt: null, updatedAt: event.updatedAt };
    case "schedule.resumed":
      return {
        ...current,
        state: "enabled",
        nextOccurrenceAt: event.nextOccurrenceAt,
        updatedAt: event.updatedAt,
      };
    case "schedule.failures-acknowledged":
      return { ...current, unacknowledgedFailure: false, updatedAt: event.updatedAt };
    case "schedule.occurrence-reserved":
      return event.source === "manual"
        ? current
        : {
            ...current,
            nextOccurrenceAt: event.nextOccurrenceAt,
            updatedAt: event.updatedAt,
          };
    case "schedule.occurrence-triggered":
    case "schedule.occurrence-failed":
      return {
        ...current,
        state: event.state,
        ...(event.type === "schedule.occurrence-failed" && event.nextOccurrenceAt !== undefined
          ? { nextOccurrenceAt: event.nextOccurrenceAt }
          : {}),
        latestHistory: event.entry,
        unacknowledgedFailure: event.unacknowledgedFailure,
        updatedAt: event.updatedAt,
      };
    case "schedule.occurrences-skipped":
      return { ...current, latestHistory: event.entry, updatedAt: event.updatedAt };
  }
}

export interface ScheduleDecisionFacts {
  readonly at: ScheduleStoredDefinition["updatedAt"];
  readonly nextOccurrenceAt?: ScheduleStoredDefinition["nextOccurrenceAt"];
}

export interface ScheduleDecisionError {
  readonly failure:
    | Extract<ScheduleOperationFailure, "already_exists" | "not_found" | "invalid_state">
    | "missing_validated_timing";
  readonly message: string;
}

export type ScheduleDecision =
  | {
      readonly ok: true;
      readonly event: ScheduleDomainEvent;
      readonly detail: ScheduleStoredDefinition | null;
    }
  | { readonly ok: false; readonly error: ScheduleDecisionError };

export type ScheduleHistoryWrite =
  | {
      readonly type: "append";
      readonly entry: ScheduleHistoryEntry;
    }
  | {
      readonly type: "replace-latest";
      readonly entry: Extract<ScheduleHistoryEntry, { readonly type: "failed" }>;
    };

type ScheduleFailedHistoryWrite =
  | {
      readonly type: "append";
      readonly entry: Extract<ScheduleHistoryEntry, { readonly type: "failed" }>;
    }
  | {
      readonly type: "replace-latest";
      readonly entry: Extract<ScheduleHistoryEntry, { readonly type: "failed" }>;
    };

export interface ScheduleLifecycleDecision {
  readonly events: readonly [ScheduleDomainEvent, ...ReadonlyArray<ScheduleDomainEvent>];
  readonly history: ReadonlyArray<ScheduleHistoryWrite>;
}

export type ScheduleTriggerOutcome =
  | {
      readonly type: "triggered";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "failed";
      readonly threadId: null;
      readonly code?: string;
      readonly message?: string;
    };

export interface ScheduleOccurrenceTransition {
  readonly status: ScheduleTriggerOutcome["type"];
  readonly scheduledFor: ScheduleStoredDefinition["updatedAt"];
  readonly threadId: ThreadId | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ScheduleOccurrenceDecision extends ScheduleLifecycleDecision {
  readonly occurrence: ScheduleOccurrenceTransition;
}

export interface ScheduleReservationDecision extends ScheduleLifecycleDecision {
  readonly occurrence: {
    readonly status: "pending";
    readonly scheduledFor: ScheduleStoredDefinition["updatedAt"];
  };
}

export function keepsOneTimeOccurrence(
  current: ScheduleStoredDefinition,
  command: Extract<ScheduleCommand, { readonly type: "schedule.update" }>,
): boolean {
  return (
    current.timing.type === "one-time" &&
    command.timing.type === "one-time" &&
    current.timing.runAt === command.timing.runAt
  );
}

function accepted(
  current: ScheduleStoredDefinition | null,
  event: ScheduleDomainEvent,
): ScheduleDecision {
  return { ok: true, event, detail: evolveScheduleDefinition(current, event) };
}

function timingFact(
  facts: ScheduleDecisionFacts,
):
  | { readonly ok: true; readonly value: ScheduleStoredDefinition["nextOccurrenceAt"] }
  | { readonly ok: false; readonly error: ScheduleDecisionError } {
  if (facts.nextOccurrenceAt !== undefined) return { ok: true, value: facts.nextOccurrenceAt };
  return {
    ok: false,
    error: {
      failure: "missing_validated_timing",
      message: "A validated next Occurrence is required for this Schedule transition.",
    },
  };
}

export function decideSchedule(input: {
  readonly current: ScheduleStoredDefinition | null;
  readonly command: ScheduleCommand;
  readonly facts: ScheduleDecisionFacts;
}): ScheduleDecision {
  const { command, current, facts } = input;
  if (command.type === "schedule.create") {
    if (current !== null) {
      return {
        ok: false,
        error: {
          failure: "already_exists",
          message: "A Schedule with this identity already exists.",
        },
      };
    }
    const timing = timingFact(facts);
    if (!timing.ok) return timing;
    const definition: ScheduleStoredDefinition = {
      id: command.scheduleId,
      projectId: command.projectId,
      name: command.name,
      prompt: command.prompt,
      timing: command.timing,
      timeZone: command.timeZone,
      execution: command.execution,
      state: command.state,
      nextOccurrenceAt: command.state === "enabled" ? timing.value : null,
      latestHistory: null,
      unacknowledgedFailure: false,
      createdAt: facts.at,
      updatedAt: facts.at,
    };
    return accepted(current, { type: "schedule.created", command, definition });
  }

  if (current === null) {
    return {
      ok: false,
      error: { failure: "not_found", message: "Schedule was not found." },
    };
  }

  switch (command.type) {
    case "schedule.update": {
      const timing = timingFact(facts);
      if (!timing.ok) return timing;
      const keepsOccurrence = keepsOneTimeOccurrence(current, command);
      const terminal = current.state === "completed" || current.state === "failed";
      const state = terminal && !keepsOccurrence ? "enabled" : current.state;
      return accepted(current, {
        type: "schedule.updated",
        command,
        state,
        nextOccurrenceAt: state === "enabled" ? timing.value : null,
        updatedAt: facts.at,
      });
    }
    case "schedule.pause":
      if (current.state === "completed" || current.state === "failed") {
        return {
          ok: false,
          error: {
            failure: "invalid_state",
            message: "A terminal one-time Schedule cannot be paused.",
          },
        };
      }
      return accepted(current, { type: "schedule.paused", command, updatedAt: facts.at });
    case "schedule.resume": {
      const timing = timingFact(facts);
      if (!timing.ok) return timing;
      return accepted(current, {
        type: "schedule.resumed",
        command,
        nextOccurrenceAt: timing.value,
        updatedAt: facts.at,
      });
    }
    case "schedule.acknowledge-failures":
      return accepted(current, {
        type: "schedule.failures-acknowledged",
        command,
        updatedAt: facts.at,
      });
    case "schedule.delete":
      return accepted(current, { type: "schedule.deleted", command });
    case "schedule.run-now":
      return accepted(current, {
        type: "schedule.occurrence-reserved",
        occurrenceId: command.occurrenceId,
        scheduledFor: facts.at,
        source: "manual",
      });
  }
}

function failedHistoryWrite(
  current: ScheduleStoredDefinition,
  entry: Extract<ScheduleHistoryEntry, { readonly type: "failed" }>,
): ScheduleFailedHistoryWrite {
  const latest = current.latestHistory;
  return latest?.type === "failed" && latest.code === entry.code && latest.message === entry.message
    ? {
        type: "replace-latest",
        entry: {
          ...entry,
          count: latest.count + 1,
          firstFailedAt: latest.firstFailedAt,
        },
      }
    : { type: "append", entry };
}

export function decideScheduledOccurrenceReservation(input: {
  readonly occurrenceId: OccurrenceId;
  readonly scheduledFor: ScheduleStoredDefinition["updatedAt"];
  readonly nextOccurrenceAt: ScheduleStoredDefinition["nextOccurrenceAt"];
  readonly skipped: {
    readonly count: number;
    readonly countIsLowerBound: boolean;
    readonly firstScheduledFor: ScheduleStoredDefinition["updatedAt"];
    readonly lastScheduledFor: ScheduleStoredDefinition["updatedAt"];
  } | null;
  readonly at: ScheduleStoredDefinition["updatedAt"];
}): ScheduleReservationDecision {
  const skippedEntry: Extract<ScheduleHistoryEntry, { readonly type: "skipped" }> | null =
    input.skipped === null
      ? null
      : {
          type: "skipped",
          count: input.skipped.count,
          countIsLowerBound: input.skipped.countIsLowerBound,
          firstScheduledFor: input.skipped.firstScheduledFor,
          lastScheduledFor: input.skipped.lastScheduledFor,
          recordedAt: input.at,
        };
  const reservation: ScheduleDomainEvent = {
    type: "schedule.occurrence-reserved",
    occurrenceId: input.occurrenceId,
    scheduledFor: input.scheduledFor,
    source: "scheduled",
    nextOccurrenceAt: input.nextOccurrenceAt,
    updatedAt: input.at,
  };
  if (skippedEntry === null) {
    return {
      events: [reservation],
      history: [],
      occurrence: { status: "pending", scheduledFor: input.scheduledFor },
    };
  }
  return {
    events: [
      { type: "schedule.occurrences-skipped", entry: skippedEntry, updatedAt: input.at },
      reservation,
    ],
    history: [{ type: "append", entry: skippedEntry }],
    occurrence: { status: "pending", scheduledFor: input.scheduledFor },
  };
}

export function decideInvalidTimingFailure(input: {
  readonly current: ScheduleStoredDefinition;
  readonly occurrenceId: OccurrenceId;
  readonly at: ScheduleStoredDefinition["updatedAt"];
  readonly cause: unknown;
}): ScheduleOccurrenceDecision {
  const scheduledFor = input.current.nextOccurrenceAt ?? input.at;
  const message =
    input.cause instanceof Error ? input.cause.message : "The saved Schedule timing is invalid.";
  const history = failedHistoryWrite(input.current, {
    type: "failed",
    occurrenceId: input.occurrenceId,
    scheduledFor,
    failedAt: input.at,
    code: "invalid_timing",
    message,
    count: 1,
    firstFailedAt: input.at,
    lastFailedAt: input.at,
  });
  return {
    events: [
      {
        type: "schedule.occurrence-failed",
        entry: history.entry,
        state: "failed",
        nextOccurrenceAt: null,
        unacknowledgedFailure: true,
        updatedAt: input.at,
      },
    ],
    history: [history],
    occurrence: {
      status: "failed",
      scheduledFor,
      threadId: null,
      errorCode: "invalid_timing",
      errorMessage: message,
    },
  };
}

export function decideOccurrenceOutcome(input: {
  readonly current: ScheduleStoredDefinition;
  readonly sourceDefinition: ScheduleStoredDefinition;
  readonly occurrenceId: OccurrenceId;
  readonly scheduledFor: ScheduleStoredDefinition["updatedAt"];
  readonly source: "scheduled" | "manual";
  readonly outcome: ScheduleTriggerOutcome;
  readonly at: ScheduleStoredDefinition["updatedAt"];
}): ScheduleOccurrenceDecision {
  if (input.outcome.type === "triggered") {
    const entry: Extract<ScheduleHistoryEntry, { readonly type: "triggered" }> = {
      type: "triggered",
      occurrenceId: input.occurrenceId,
      scheduledFor: input.scheduledFor,
      triggeredAt: input.at,
      threadId: input.outcome.threadId,
    };
    const state =
      input.source === "scheduled" && input.sourceDefinition.timing.type === "one-time"
        ? "completed"
        : input.current.state;
    return {
      events: [
        {
          type: "schedule.occurrence-triggered",
          entry,
          state,
          unacknowledgedFailure: input.current.unacknowledgedFailure,
          updatedAt: input.at,
        },
      ],
      history: [{ type: "append", entry }],
      occurrence: {
        status: "triggered",
        scheduledFor: input.scheduledFor,
        threadId: input.outcome.threadId,
        errorCode: null,
        errorMessage: null,
      },
    };
  }

  const code = input.outcome.code ?? "trigger_failed";
  const message = input.outcome.message ?? "The Occurrence could not Trigger.";
  const history = failedHistoryWrite(input.current, {
    type: "failed",
    occurrenceId: input.occurrenceId,
    scheduledFor: input.scheduledFor,
    failedAt: input.at,
    code,
    message,
    count: 1,
    firstFailedAt: input.at,
    lastFailedAt: input.at,
  });
  const state =
    input.source === "scheduled" && input.sourceDefinition.timing.type === "one-time"
      ? "failed"
      : input.current.state;
  return {
    events: [
      {
        type: "schedule.occurrence-failed",
        entry: history.entry,
        state,
        unacknowledgedFailure: true,
        updatedAt: input.at,
      },
    ],
    history: [history],
    occurrence: {
      status: "failed",
      scheduledFor: input.scheduledFor,
      threadId: null,
      errorCode: input.outcome.code ?? null,
      errorMessage: input.outcome.message ?? null,
    },
  };
}
