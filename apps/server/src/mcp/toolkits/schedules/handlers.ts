import {
  CommandId,
  type CreateScheduleInput,
  type GetScheduleInput,
  type GetScheduleResult,
  type ListSchedulesInput,
  type ListSchedulesResult,
  OccurrenceId,
  type OrchestrationThreadShell,
  type ProjectId,
  type RunScheduleNowInput,
  type RunScheduleNowResult,
  SCHEDULE_FREQUENCY_WARNING_RUNS_PER_DAY,
  SCHEDULE_PROMPT_PREVIEW_CHARS,
  SCHEDULE_UPCOMING_OCCURRENCE_COUNT,
  type ScheduleDetail,
  ScheduleId,
  ScheduleOrchestrationDeniedError,
  ScheduleOrchestrationDomainError,
  ScheduleOrchestrationInvalidInputError,
  ScheduleOrchestrationNameConflictError,
  ScheduleOrchestrationOperationError,
  type ScheduleOperationError,
  type ScheduleState,
  type ScheduleSummaryView,
  type ScheduleTiming,
  type ScheduleWriteResult,
  type SetScheduleStateInput,
  type ThreadEnvMode,
  type ThreadId,
  type UpdateScheduleInput,
} from "@t3tools/contracts";
import { describeScheduleCadence } from "@t3tools/shared/scheduleCadence";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ScheduleService from "../../../schedule/ScheduleService.ts";
import { previewScheduleTiming } from "../../../schedule/timing.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SchedulesToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const operationError = (message: string) => (cause: unknown) =>
  new ScheduleOrchestrationOperationError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

/**
 * Domain rejections keep their failure code: `invalid_timing` and
 * `provider_unavailable` need completely different responses from an agent, and
 * flattening both into prose costs it the difference.
 */
const domainError = (error: ScheduleOperationError) =>
  new ScheduleOrchestrationDomainError({
    message: error.message,
    failure: error.failure,
    ...(error.scheduleId !== undefined ? { scheduleId: error.scheduleId } : {}),
  });

/** States a Schedule can still fire from, and so still own its name. */
const LIVE_STATES: ReadonlySet<ScheduleState> = new Set<ScheduleState>(["enabled", "paused"]);

const normalizeName = (name: string) => name.trim().toLocaleLowerCase();

/**
 * The zone the server itself is in. A Schedule's zone decides what its cron
 * expression means, and an agent asked for "6am" means the user's 6am — the
 * host's zone is the closest thing to that this process can know.
 */
const serverTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const truncatePrompt = (prompt: string) => {
  if (prompt.length <= SCHEDULE_PROMPT_PREVIEW_CHARS) {
    return { prompt, promptLength: prompt.length, promptTruncated: false };
  }
  return {
    // Slice on a code-point boundary so a surrogate pair cannot be halved.
    prompt: `${[...prompt].slice(0, SCHEDULE_PROMPT_PREVIEW_CHARS).join("")}…`,
    promptLength: prompt.length,
    promptTruncated: true,
  };
};

/**
 * Warning text when a cadence produces enough runs to be worth saying out loud.
 * Every firing is a fresh thread that nothing deletes, so the count is the fact
 * the user needs before it becomes a housekeeping problem.
 */
const frequencyWarning = (occurrences: ReadonlyArray<string>): string | null => {
  if (occurrences.length < 2) return null;
  const times = occurrences.map((occurrence) => Date.parse(occurrence));
  if (times.some((time) => Number.isNaN(time))) return null;
  let total = 0;
  for (let index = 1; index < times.length; index += 1) {
    total += (times[index] as number) - (times[index - 1] as number);
  }
  const averageGapMs = total / (times.length - 1);
  if (averageGapMs <= 0) return null;
  const runsPerDay = Math.round(86_400_000 / averageGapMs);
  if (runsPerDay < SCHEDULE_FREQUENCY_WARNING_RUNS_PER_DAY) return null;
  return `This cadence starts about ${runsPerDay.toLocaleString()} threads per day (~${(runsPerDay * 365).toLocaleString()} per year). Phoenix never deletes them automatically — tell the user the count before leaving this Schedule enabled.`;
};

const summaryView = (detail: {
  readonly id: ScheduleId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly state: ScheduleState;
  readonly timing: ScheduleTiming;
  readonly timeZone: string;
  readonly nextOccurrenceAt: string | null;
  readonly unacknowledgedFailure: boolean;
  readonly updatedAt: string;
}): ScheduleSummaryView => ({
  scheduleId: detail.id,
  projectId: detail.projectId,
  name: detail.name,
  state: detail.state,
  timing: detail.timing,
  timeZone: detail.timeZone,
  cadence: describeScheduleCadence(detail.timing, detail.timeZone),
  nextOccurrenceAt: detail.nextOccurrenceAt,
  unacknowledgedFailure: detail.unacknowledgedFailure,
  updatedAt: detail.updatedAt,
});

// Exported so tests can drive the real handlers against stub services. The
// wiring between them — deriving the calling project, merging a patch onto the
// stored definition, reading the write back — is what pure helper tests cannot
// see.
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const schedules = yield* ScheduleService.ScheduleService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(operationError("Failed to generate identifier")),
  );
  const commandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`mcp:${tag}:${uuid}`)));

  // Read per call rather than at layer build, so flipping the setting takes
  // effect for already-running sessions on their next tool call.
  const requireSchedules = Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.requireMcpSchedulesCapability();
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(operationError("Failed to read server settings")),
    );
    if (!settings.enableScheduleManagement) {
      return yield* new ScheduleOrchestrationDeniedError({
        reason: "disabled_in_settings",
        message:
          "Schedule management is disabled in this environment's settings (Settings → General → Schedule management).",
      });
    }
    return invocation;
  });

  /**
   * The calling session's own thread. Writes derive their project from it
   * rather than taking a projectId, so an agent cannot author automation into a
   * project it is not working in, and execution settings default to the ones
   * this session is provably running with.
   */
  const callingThread = Effect.gen(function* () {
    const invocation = yield* requireSchedules;
    const shell = yield* snapshotQuery
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(operationError("Failed to read the calling session's thread")));
    if (Option.isNone(shell)) {
      return yield* new ScheduleOrchestrationOperationError({
        message: "The calling session's thread could not be read.",
      });
    }
    return shell.value;
  });

  const getDetail = (scheduleId: ScheduleId) =>
    schedules.getDetail(scheduleId).pipe(Effect.mapError(domainError));

  /** Writes stay in the calling session's project; reads may look wider. */
  const requireWritableSchedule = Effect.fn("schedules.requireWritable")(function* (
    scheduleId: ScheduleId,
  ) {
    const shell = yield* callingThread;
    const detail = yield* getDetail(scheduleId);
    if (detail.projectId !== shell.projectId) {
      return yield* new ScheduleOrchestrationDeniedError({
        reason: "not_in_calling_project",
        message: `Schedule ${scheduleId} belongs to another project. This session can only change Schedules in the project it is working in.`,
      });
    }
    return { shell, detail };
  });

  const upcomingOccurrences = (detail: {
    readonly timing: ScheduleTiming;
    readonly timeZone: string;
    readonly nextOccurrenceAt: string | null;
  }) =>
    nowIso.pipe(
      Effect.map((now) => {
        try {
          return previewScheduleTiming(detail.timing, detail.timeZone, now, {
            previewCount: SCHEDULE_UPCOMING_OCCURRENCE_COUNT,
            allowPastOneTime: true,
          });
        } catch {
          // A stored Schedule whose timing no longer previews (a one-time run
          // already in the past, say) still has a definite answer.
          return detail.nextOccurrenceAt === null ? [] : [detail.nextOccurrenceAt];
        }
      }),
    );

  const writeResult = (detail: ScheduleDetail): Effect.Effect<ScheduleWriteResult> =>
    upcomingOccurrences(detail).pipe(
      Effect.map((occurrences) => ({
        ...summaryView(detail),
        upcomingOccurrences: occurrences,
        frequencyWarning: detail.state === "enabled" ? frequencyWarning(occurrences) : null,
      })),
    );

  const executionFor = (
    shell: OrchestrationThreadShell,
    current: ScheduleDetail | null,
    overrides: {
      readonly model?: string | undefined;
      readonly workspaceMode?: ThreadEnvMode | undefined;
      readonly baseBranch?: string | undefined;
    },
  ) => {
    const base = current?.execution ?? {
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      workspaceMode: (shell.worktreePath === null ? "local" : "worktree") as ThreadEnvMode,
      baseBranch: null,
    };
    return {
      ...base,
      modelSelection:
        overrides.model === undefined
          ? base.modelSelection
          : { ...base.modelSelection, model: overrides.model },
      workspaceMode: overrides.workspaceMode ?? base.workspaceMode,
      baseBranch: overrides.baseBranch ?? base.baseBranch,
    };
  };

  const listSchedules = Effect.fn("schedules.list")(function* (input: ListSchedulesInput) {
    const shell = yield* callingThread;
    const snapshot = yield* schedules.getSnapshot().pipe(Effect.mapError(domainError));
    const visible = snapshot.schedules.filter((schedule) => {
      if (input.allProjects !== true && schedule.projectId !== shell.projectId) return false;
      if (input.state !== undefined && schedule.state !== input.state) return false;
      return true;
    });
    return {
      schedules: visible.map(summaryView),
      callingProjectId: shell.projectId,
    } satisfies ListSchedulesResult;
  });

  const getSchedule = Effect.fn("schedules.get")(function* (input: GetScheduleInput) {
    yield* requireSchedules;
    const detail = yield* getDetail(input.scheduleId);
    const occurrences = yield* upcomingOccurrences(detail);
    return {
      ...summaryView(detail),
      ...truncatePrompt(detail.prompt),
      history: detail.history,
      upcomingOccurrences: occurrences,
    } satisfies GetScheduleResult;
  });

  const createSchedule = Effect.fn("schedules.create")(function* (input: CreateScheduleInput) {
    const shell = yield* callingThread;
    const snapshot = yield* schedules.getSnapshot().pipe(Effect.mapError(domainError));
    const wanted = normalizeName(input.name);
    const clash = snapshot.schedules.find(
      (schedule) =>
        schedule.projectId === shell.projectId &&
        LIVE_STATES.has(schedule.state) &&
        normalizeName(schedule.name) === wanted,
    );
    if (clash !== undefined) {
      // No delete on this surface, so a duplicate is one the agent cannot take
      // back — refuse and point at the Schedule it should edit instead.
      return yield* new ScheduleOrchestrationNameConflictError({
        scheduleId: clash.id,
        name: clash.name,
        message: `This project already has a Schedule named "${clash.name}". Update it with update_schedule (scheduleId ${clash.id}) or choose a different name.`,
      });
    }

    const scheduleId = ScheduleId.make(yield* randomUUID);
    yield* schedules
      .dispatch({
        type: "schedule.create",
        commandId: yield* commandId("schedule-create"),
        scheduleId,
        projectId: shell.projectId,
        name: input.name,
        prompt: input.prompt,
        timing: input.timing,
        timeZone: input.timeZone ?? serverTimeZone(),
        execution: executionFor(shell, null, input),
        state: "enabled",
      })
      .pipe(Effect.mapError(domainError));

    return yield* writeResult(yield* getDetail(scheduleId));
  });

  const updateSchedule = Effect.fn("schedules.update")(function* (input: UpdateScheduleInput) {
    const { shell, detail } = yield* requireWritableSchedule(input.scheduleId);
    if (
      input.name === undefined &&
      input.prompt === undefined &&
      input.timing === undefined &&
      input.timeZone === undefined &&
      input.model === undefined &&
      input.workspaceMode === undefined &&
      input.baseBranch === undefined
    ) {
      return yield* new ScheduleOrchestrationInvalidInputError({
        message: "Pass at least one field to change.",
      });
    }

    // Patch semantics over a command that only accepts a whole definition: the
    // stored values fill every field the caller did not send, so moving a
    // Schedule's time never requires resending a prompt nobody read.
    yield* schedules
      .dispatch({
        type: "schedule.update",
        commandId: yield* commandId("schedule-update"),
        scheduleId: input.scheduleId,
        projectId: detail.projectId,
        name: input.name ?? detail.name,
        prompt: input.prompt ?? detail.prompt,
        timing: input.timing ?? detail.timing,
        timeZone: input.timeZone ?? detail.timeZone,
        execution: executionFor(shell, detail, input),
      })
      .pipe(Effect.mapError(domainError));

    return yield* writeResult(yield* getDetail(input.scheduleId));
  });

  const setScheduleState = Effect.fn("schedules.setState")(function* (
    input: SetScheduleStateInput,
  ) {
    const { detail } = yield* requireWritableSchedule(input.scheduleId);
    if (detail.state === input.state) {
      return yield* writeResult(detail);
    }
    yield* schedules
      .dispatch(
        input.state === "paused"
          ? {
              type: "schedule.pause",
              commandId: yield* commandId("schedule-pause"),
              scheduleId: input.scheduleId,
            }
          : {
              type: "schedule.resume",
              commandId: yield* commandId("schedule-resume"),
              scheduleId: input.scheduleId,
            },
      )
      .pipe(Effect.mapError(domainError));

    return yield* writeResult(yield* getDetail(input.scheduleId));
  });

  const runScheduleNow = Effect.fn("schedules.runNow")(function* (input: RunScheduleNowInput) {
    yield* requireWritableSchedule(input.scheduleId);
    const occurrenceId = OccurrenceId.make(yield* randomUUID);
    yield* schedules
      .dispatch({
        type: "schedule.run-now",
        commandId: yield* commandId("schedule-run-now"),
        scheduleId: input.scheduleId,
        occurrenceId,
      })
      .pipe(Effect.mapError(domainError));

    // run-now triggers inline, so the thread it started is already in history.
    const after = yield* getDetail(input.scheduleId);
    const triggered = after.history.find(
      (entry) => entry.type === "triggered" && entry.occurrenceId === occurrenceId,
    );
    return {
      scheduleId: after.id,
      name: after.name,
      occurrenceId,
      threadId: triggered?.type === "triggered" ? (triggered.threadId as ThreadId) : null,
      state: after.state,
    } satisfies RunScheduleNowResult;
  });

  return {
    list_schedules: (input) => listSchedules(input ?? {}),
    get_schedule: (input) => getSchedule(input),
    create_schedule: (input) => createSchedule(input),
    update_schedule: (input) => updateSchedule(input),
    set_schedule_state: (input) => setScheduleState(input),
    run_schedule_now: (input) => runScheduleNow(input),
  } satisfies Parameters<typeof SchedulesToolkit.toLayer>[0];
});

export const SchedulesToolkitHandlersLive = SchedulesToolkit.toLayer(make);
