import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import {
  OccurrenceId,
  ScheduleHistoryEntry,
  ScheduleId,
  ScheduleOperationFailure,
  ScheduleState,
  ScheduleTiming,
} from "./schedule.ts";

/**
 * The MCP-facing Schedule surface: the shapes the `schedules` toolkit takes and
 * returns. The durable Schedule contract lives in `schedule.ts`; this module is
 * the agent's view of it, which differs in three deliberate ways.
 *
 * Writes never carry a projectId — the toolkit derives it from the calling
 * session's thread, so an agent cannot author automation into a project it is
 * not working in. Prompts come back truncated, because a Schedule's prompt runs
 * to 120k characters and an agent usually needs to recognize one, not reproduce
 * it. And every write returns its next few occurrences, so the agent can read
 * back what it actually built rather than trusting a cron string it wrote.
 */

/** Prompt characters returned by get_schedule before truncation kicks in. */
export const SCHEDULE_PROMPT_PREVIEW_CHARS = 4_000;

/** Upcoming occurrences returned alongside every write. */
export const SCHEDULE_UPCOMING_OCCURRENCE_COUNT = 5;

/**
 * Runs per day at or above which a write result carries a frequency warning.
 * Four an hour is the point where a Schedule starts producing more threads per
 * week than a person will read.
 */
export const SCHEDULE_FREQUENCY_WARNING_RUNS_PER_DAY = 96;

export const ScheduleSummaryView = Schema.Struct({
  scheduleId: ScheduleId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  state: ScheduleState,
  timing: ScheduleTiming,
  timeZone: TrimmedNonEmptyString,
  // Plain-language rendering of timing, e.g. "Weekdays at 06:00".
  cadence: TrimmedNonEmptyString,
  nextOccurrenceAt: Schema.NullOr(IsoDateTime),
  unacknowledgedFailure: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ScheduleSummaryView = typeof ScheduleSummaryView.Type;

const ALL_PROJECTS_DESCRIPTION =
  "List Schedules from every project in this environment rather than only the calling session's project. Defaults to false.";
const STATE_FILTER_DESCRIPTION =
  "Return only Schedules in this state. Omit for all of them regardless of state.";

export const ListSchedulesInput = Schema.Struct({
  allProjects: Schema.optional(
    Schema.Boolean.annotate({ description: ALL_PROJECTS_DESCRIPTION }),
  ).annotate({ description: ALL_PROJECTS_DESCRIPTION }),
  state: Schema.optional(
    ScheduleState.annotate({ description: STATE_FILTER_DESCRIPTION }),
  ).annotate({ description: STATE_FILTER_DESCRIPTION }),
});
export type ListSchedulesInput = typeof ListSchedulesInput.Type;

export const ListSchedulesResult = Schema.Struct({
  schedules: Schema.Array(ScheduleSummaryView),
  // The project writes would target, so the agent can say which one it is on.
  callingProjectId: ProjectId,
});
export type ListSchedulesResult = typeof ListSchedulesResult.Type;

const SCHEDULE_ID_DESCRIPTION = "Identifier of the Schedule, as returned by list_schedules.";

export const GetScheduleInput = Schema.Struct({
  scheduleId: ScheduleId.annotate({ description: SCHEDULE_ID_DESCRIPTION }),
});
export type GetScheduleInput = typeof GetScheduleInput.Type;

export const GetScheduleResult = Schema.Struct({
  ...ScheduleSummaryView.fields,
  prompt: TrimmedNonEmptyString,
  promptLength: NonNegativeInt,
  promptTruncated: Schema.Boolean,
  history: Schema.Array(ScheduleHistoryEntry),
  upcomingOccurrences: Schema.Array(IsoDateTime),
});
export type GetScheduleResult = typeof GetScheduleResult.Type;

const MODEL_DESCRIPTION =
  "Model slug for the Schedule's runs, from list_session_providers. Defaults to the calling session's own model, which is known to work in this environment.";
const WORKSPACE_MODE_DESCRIPTION =
  'Where a run works: "worktree" gives each run its own git worktree, "local" runs in the project directory. Defaults to the calling session\'s own mode; a recurring Schedule usually wants "worktree" so its runs cannot collide with live work.';
const TIME_ZONE_DESCRIPTION =
  'IANA time zone deciding what the timing means, e.g. "Europe/London". Defaults to the server environment\'s own zone; the resolved zone is always echoed back in the result.';
const TIMING_DESCRIPTION =
  'When the Schedule runs: {type: "cron", expression} with a standard five-field cron expression (at least five minutes apart), or {type: "one-time", runAt} with a future ISO-8601 instant.';
const NAME_DESCRIPTION =
  "Short human-readable name, unique among the live Schedules in this project.";
const PROMPT_DESCRIPTION =
  "The prompt each run starts its new thread with. Write it as a standalone instruction: nothing from this conversation carries over.";

const ScheduleExecutionOverrides = {
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: MODEL_DESCRIPTION }),
  ).annotate({ description: MODEL_DESCRIPTION }),
  workspaceMode: Schema.optional(
    ThreadEnvMode.annotate({ description: WORKSPACE_MODE_DESCRIPTION }),
  ).annotate({ description: WORKSPACE_MODE_DESCRIPTION }),
};

export const CreateScheduleInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
    description: NAME_DESCRIPTION,
  }),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
    description: PROMPT_DESCRIPTION,
  }),
  timing: ScheduleTiming.annotate({ description: TIMING_DESCRIPTION }),
  timeZone: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: TIME_ZONE_DESCRIPTION,
    }),
  ).annotate({ description: TIME_ZONE_DESCRIPTION }),
  ...ScheduleExecutionOverrides,
});
export type CreateScheduleInput = typeof CreateScheduleInput.Type;

export const UpdateScheduleInput = Schema.Struct({
  scheduleId: ScheduleId.annotate({ description: SCHEDULE_ID_DESCRIPTION }),
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: NAME_DESCRIPTION,
    }),
  ).annotate({ description: NAME_DESCRIPTION }),
  prompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: PROMPT_DESCRIPTION,
    }),
  ).annotate({ description: PROMPT_DESCRIPTION }),
  timing: Schema.optional(ScheduleTiming.annotate({ description: TIMING_DESCRIPTION })).annotate({
    description: TIMING_DESCRIPTION,
  }),
  timeZone: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: TIME_ZONE_DESCRIPTION,
    }),
  ).annotate({ description: TIME_ZONE_DESCRIPTION }),
  ...ScheduleExecutionOverrides,
});
export type UpdateScheduleInput = typeof UpdateScheduleInput.Type;

export const SetScheduleStateInput = Schema.Struct({
  scheduleId: ScheduleId.annotate({ description: SCHEDULE_ID_DESCRIPTION }),
  state: Schema.Literals(["enabled", "paused"]).annotate({
    description:
      '"paused" stops the Schedule firing while keeping it and its history; "enabled" starts it firing again from its next occurrence.',
  }),
});
export type SetScheduleStateInput = typeof SetScheduleStateInput.Type;

export const ScheduleWriteResult = Schema.Struct({
  ...ScheduleSummaryView.fields,
  upcomingOccurrences: Schema.Array(IsoDateTime),
  // Set when the cadence produces enough runs to be worth saying out loud, so
  // the agent can repeat the count to the user before it becomes their problem.
  frequencyWarning: Schema.NullOr(TrimmedNonEmptyString),
});
export type ScheduleWriteResult = typeof ScheduleWriteResult.Type;

export const RunScheduleNowInput = Schema.Struct({
  scheduleId: ScheduleId.annotate({ description: SCHEDULE_ID_DESCRIPTION }),
});
export type RunScheduleNowInput = typeof RunScheduleNowInput.Type;

export const RunScheduleNowResult = Schema.Struct({
  ...ScheduleSummaryView.fields,
  occurrenceId: OccurrenceId,
  // Null when the run was reserved but its thread was not readable back in
  // time; the run is still underway and will appear in the Schedule's history.
  threadId: Schema.NullOr(ThreadId),
});
export type RunScheduleNowResult = typeof RunScheduleNowResult.Type;

const ScheduleOrchestrationErrorFields = {
  message: Schema.String,
};

export class ScheduleOrchestrationDeniedError extends Schema.TaggedErrorClass<ScheduleOrchestrationDeniedError>()(
  "ScheduleOrchestrationDeniedError",
  {
    ...ScheduleOrchestrationErrorFields,
    reason: Schema.Literals([
      "capability_unavailable",
      "disabled_in_settings",
      "not_in_calling_project",
    ]),
  },
) {}

/**
 * create_schedule refused to add a second Schedule with an existing name.
 *
 * Structured because the caller's next move is mechanical: switch to
 * update_schedule against `scheduleId`. Duplicates matter more here than in the
 * UI — this toolkit has no delete, so an agent that creates one cannot take it
 * back, only pause it and leave the user to clean up.
 */
export class ScheduleOrchestrationNameConflictError extends Schema.TaggedErrorClass<ScheduleOrchestrationNameConflictError>()(
  "ScheduleOrchestrationNameConflictError",
  {
    ...ScheduleOrchestrationErrorFields,
    scheduleId: ScheduleId,
    name: TrimmedNonEmptyString,
  },
) {}

export class ScheduleOrchestrationInvalidInputError extends Schema.TaggedErrorClass<ScheduleOrchestrationInvalidInputError>()(
  "ScheduleOrchestrationInvalidInputError",
  ScheduleOrchestrationErrorFields,
) {}

/**
 * A Schedule domain rejection, passed through with its failure code intact
 * rather than flattened into prose — `invalid_timing` and `provider_unavailable`
 * call for completely different responses from the agent.
 */
export class ScheduleOrchestrationDomainError extends Schema.TaggedErrorClass<ScheduleOrchestrationDomainError>()(
  "ScheduleOrchestrationDomainError",
  {
    ...ScheduleOrchestrationErrorFields,
    failure: ScheduleOperationFailure,
    scheduleId: Schema.optional(ScheduleId),
  },
) {}

export class ScheduleOrchestrationOperationError extends Schema.TaggedErrorClass<ScheduleOrchestrationOperationError>()(
  "ScheduleOrchestrationOperationError",
  ScheduleOrchestrationErrorFields,
) {}

export const ScheduleOrchestrationError = Schema.Union([
  ScheduleOrchestrationDeniedError,
  ScheduleOrchestrationNameConflictError,
  ScheduleOrchestrationInvalidInputError,
  ScheduleOrchestrationDomainError,
  ScheduleOrchestrationOperationError,
]);
export type ScheduleOrchestrationError = typeof ScheduleOrchestrationError.Type;
