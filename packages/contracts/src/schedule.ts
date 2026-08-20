import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

export const ScheduleId = TrimmedNonEmptyString.pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;

export const OccurrenceId = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  ),
).pipe(Schema.brand("OccurrenceId"));
export type OccurrenceId = typeof OccurrenceId.Type;

export const ScheduleState = Schema.Literals(["enabled", "paused", "completed", "failed"]);
export type ScheduleState = typeof ScheduleState.Type;

export const ScheduleOneTimeTiming = Schema.Struct({
  type: Schema.Literal("one-time"),
  runAt: IsoDateTime,
});
export type ScheduleOneTimeTiming = typeof ScheduleOneTimeTiming.Type;

export const ScheduleCronTiming = Schema.Struct({
  type: Schema.Literal("cron"),
  expression: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ScheduleCronTiming = typeof ScheduleCronTiming.Type;

export const ScheduleTiming = Schema.Union([ScheduleOneTimeTiming, ScheduleCronTiming]);
export type ScheduleTiming = typeof ScheduleTiming.Type;

export const ScheduleExecution = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceMode: ThreadEnvMode,
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ScheduleExecution = typeof ScheduleExecution.Type;

export const ScheduleTriggeredHistory = Schema.Struct({
  type: Schema.Literal("triggered"),
  occurrenceId: OccurrenceId,
  scheduledFor: IsoDateTime,
  triggeredAt: IsoDateTime,
  threadId: ThreadId,
});
export type ScheduleTriggeredHistory = typeof ScheduleTriggeredHistory.Type;

export const ScheduleFailedHistory = Schema.Struct({
  type: Schema.Literal("failed"),
  occurrenceId: OccurrenceId,
  scheduledFor: IsoDateTime,
  failedAt: IsoDateTime,
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  firstFailedAt: IsoDateTime,
  lastFailedAt: IsoDateTime,
});
export type ScheduleFailedHistory = typeof ScheduleFailedHistory.Type;

export const ScheduleSkippedHistory = Schema.Struct({
  type: Schema.Literal("skipped"),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  countIsLowerBound: Schema.Boolean,
  firstScheduledFor: IsoDateTime,
  lastScheduledFor: IsoDateTime,
  recordedAt: IsoDateTime,
});
export type ScheduleSkippedHistory = typeof ScheduleSkippedHistory.Type;

export const ScheduleHistoryEntry = Schema.Union([
  ScheduleTriggeredHistory,
  ScheduleFailedHistory,
  ScheduleSkippedHistory,
]);
export type ScheduleHistoryEntry = typeof ScheduleHistoryEntry.Type;

export const ScheduleHistoryCursor = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(/^[1-9][0-9]*$/),
    Schema.makeFilter(
      (value) =>
        Number.isSafeInteger(Number(value)) || "History cursor exceeds the safe integer range",
    ),
  ),
  Schema.brand("ScheduleHistoryCursor"),
);
export type ScheduleHistoryCursor = typeof ScheduleHistoryCursor.Type;

const ScheduleDefinitionFields = {
  id: ScheduleId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  timing: ScheduleTiming,
  timeZone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  execution: ScheduleExecution,
  state: ScheduleState,
  nextOccurrenceAt: Schema.NullOr(IsoDateTime),
  latestHistory: Schema.NullOr(ScheduleHistoryEntry),
  unacknowledgedFailure: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const ScheduleSummary = Schema.Struct({
  ...ScheduleDefinitionFields,
  revision: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type ScheduleSummary = typeof ScheduleSummary.Type;

export const ScheduleDetail = Schema.Struct({
  ...ScheduleSummary.fields,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  history: Schema.Array(ScheduleHistoryEntry),
  historyNextCursor: Schema.NullOr(ScheduleHistoryCursor).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ScheduleDetail = typeof ScheduleDetail.Type;

// Durable Schedule definition projection. History is normalized separately;
// this is the complete state rebuilt by folding Schedule domain events.
export const ScheduleStoredDefinition = Schema.Struct({
  ...ScheduleDefinitionFields,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
});
export type ScheduleStoredDefinition = typeof ScheduleStoredDefinition.Type;

export const ScheduleHistoryPage = Schema.Struct({
  scheduleId: ScheduleId,
  entries: Schema.Array(ScheduleHistoryEntry),
  nextCursor: Schema.NullOr(ScheduleHistoryCursor),
});
export type ScheduleHistoryPage = typeof ScheduleHistoryPage.Type;

export const ScheduleListSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  schedules: Schema.Array(ScheduleSummary),
  updatedAt: IsoDateTime,
});
export type ScheduleListSnapshot = typeof ScheduleListSnapshot.Type;

export const ScheduleListStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("schedule-list-reset"),
    snapshot: ScheduleListSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule-upserted"),
    sequence: NonNegativeInt,
    schedule: ScheduleSummary,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule-removed"),
    sequence: NonNegativeInt,
    scheduleId: ScheduleId,
  }),
]);
export type ScheduleListStreamEvent = typeof ScheduleListStreamEvent.Type;

const ScheduleDefinitionInput = {
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  timing: ScheduleTiming,
  timeZone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  execution: ScheduleExecution,
};

export const ScheduleCreateCommand = Schema.Struct({
  type: Schema.Literal("schedule.create"),
  commandId: CommandId,
  scheduleId: ScheduleId,
  ...ScheduleDefinitionInput,
  state: Schema.Literals(["enabled", "paused"]),
});
export type ScheduleCreateCommand = typeof ScheduleCreateCommand.Type;

export const ScheduleUpdateCommand = Schema.Struct({
  type: Schema.Literal("schedule.update"),
  commandId: CommandId,
  scheduleId: ScheduleId,
  ...ScheduleDefinitionInput,
});
export type ScheduleUpdateCommand = typeof ScheduleUpdateCommand.Type;

export const SchedulePauseCommand = Schema.Struct({
  type: Schema.Literal("schedule.pause"),
  commandId: CommandId,
  scheduleId: ScheduleId,
});
export type SchedulePauseCommand = typeof SchedulePauseCommand.Type;

export const ScheduleResumeCommand = Schema.Struct({
  type: Schema.Literal("schedule.resume"),
  commandId: CommandId,
  scheduleId: ScheduleId,
});
export type ScheduleResumeCommand = typeof ScheduleResumeCommand.Type;

export const ScheduleDeleteCommand = Schema.Struct({
  type: Schema.Literal("schedule.delete"),
  commandId: CommandId,
  scheduleId: ScheduleId,
});
export type ScheduleDeleteCommand = typeof ScheduleDeleteCommand.Type;

export const ScheduleRunNowCommand = Schema.Struct({
  type: Schema.Literal("schedule.run-now"),
  commandId: CommandId,
  scheduleId: ScheduleId,
  occurrenceId: OccurrenceId,
});
export type ScheduleRunNowCommand = typeof ScheduleRunNowCommand.Type;

export const ScheduleAcknowledgeFailuresCommand = Schema.Struct({
  type: Schema.Literal("schedule.acknowledge-failures"),
  commandId: CommandId,
  scheduleId: ScheduleId,
});
export type ScheduleAcknowledgeFailuresCommand = typeof ScheduleAcknowledgeFailuresCommand.Type;

export const ScheduleCommand = Schema.Union([
  ScheduleCreateCommand,
  ScheduleUpdateCommand,
  SchedulePauseCommand,
  ScheduleResumeCommand,
  ScheduleDeleteCommand,
  ScheduleRunNowCommand,
  ScheduleAcknowledgeFailuresCommand,
]);
export type ScheduleCommand = typeof ScheduleCommand.Type;

export const ScheduleDomainEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("schedule.created"),
    command: ScheduleCreateCommand,
    definition: ScheduleStoredDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.rebased"),
    definition: ScheduleStoredDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.updated"),
    command: ScheduleUpdateCommand,
    state: ScheduleState,
    nextOccurrenceAt: Schema.NullOr(IsoDateTime),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.paused"),
    command: SchedulePauseCommand,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.resumed"),
    command: ScheduleResumeCommand,
    nextOccurrenceAt: Schema.NullOr(IsoDateTime),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.failures-acknowledged"),
    command: ScheduleAcknowledgeFailuresCommand,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.deleted"),
    command: ScheduleDeleteCommand,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.occurrence-reserved"),
    occurrenceId: OccurrenceId,
    scheduledFor: IsoDateTime,
    source: Schema.Literal("manual"),
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.occurrence-reserved"),
    occurrenceId: OccurrenceId,
    scheduledFor: IsoDateTime,
    source: Schema.Literal("scheduled"),
    nextOccurrenceAt: Schema.NullOr(IsoDateTime),
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.occurrence-triggered"),
    entry: ScheduleTriggeredHistory,
    state: ScheduleState,
    unacknowledgedFailure: Schema.Boolean,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.occurrence-failed"),
    entry: ScheduleFailedHistory,
    state: ScheduleState,
    nextOccurrenceAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    unacknowledgedFailure: Schema.Boolean,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.occurrences-skipped"),
    entry: ScheduleSkippedHistory,
    updatedAt: IsoDateTime,
  }),
]);
export type ScheduleDomainEvent = typeof ScheduleDomainEvent.Type;

export const ScheduleDispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
  scheduleId: ScheduleId,
});
export type ScheduleDispatchResult = typeof ScheduleDispatchResult.Type;

export const ScheduleGetDetailInput = Schema.Struct({ scheduleId: ScheduleId });
export type ScheduleGetDetailInput = typeof ScheduleGetDetailInput.Type;

export const ScheduleGetHistoryInput = Schema.Struct({
  scheduleId: ScheduleId,
  cursor: Schema.optional(ScheduleHistoryCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type ScheduleGetHistoryInput = typeof ScheduleGetHistoryInput.Type;

export const ScheduleOperationFailure = Schema.Literals([
  "not_found",
  "already_exists",
  "command_conflict",
  "invalid_timing",
  "invalid_time_zone",
  "invalid_state",
  "invalid_workspace",
  "project_not_found",
  "provider_unavailable",
  "model_unavailable",
  "trigger_failed",
  "persistence_failed",
]);
export type ScheduleOperationFailure = typeof ScheduleOperationFailure.Type;

export class ScheduleOperationError extends Schema.TaggedErrorClass<ScheduleOperationError>()(
  "ScheduleOperationError",
  {
    message: TrimmedNonEmptyString,
    failure: ScheduleOperationFailure,
    scheduleId: Schema.optional(ScheduleId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const SCHEDULE_WS_METHODS = {
  dispatchCommand: "schedules.dispatchCommand",
  getSnapshot: "schedules.getSnapshot",
  getDetail: "schedules.getDetail",
  getHistory: "schedules.getHistory",
  subscribe: "schedules.subscribe",
} as const;
