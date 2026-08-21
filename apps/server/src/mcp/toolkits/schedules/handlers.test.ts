import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ScheduleCommand,
  type ScheduleDetail,
  ScheduleId,
  ScheduleOperationError,
  type ScheduleSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ScheduleService from "../../../schedule/ScheduleService.ts";
import { layerTest as serverSettingsLayerTest } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";

const now = "2026-08-20T09:00:00.000Z";
const callingThreadId = ThreadId.make("thread-1");
const ownProjectId = ProjectId.make("project-own");
const otherProjectId = ProjectId.make("project-other");
const triggeredThreadId = ThreadId.make("thread-scheduled-1");

const callingShell = {
  id: callingThreadId,
  projectId: ownProjectId,
  title: "Working on the audit",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: {
    threadId: callingThreadId,
    status: "running",
    providerName: "Claude Agent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
  latestUserMessageAt: now,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} satisfies OrchestrationThreadShell;

const execution = {
  modelSelection: callingShell.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceMode: "worktree",
  baseBranch: null,
} satisfies ScheduleDetail["execution"];

const scheduleDetail = (overrides: Partial<ScheduleDetail> = {}): ScheduleDetail => ({
  id: ScheduleId.make("schedule-1"),
  projectId: ownProjectId,
  name: "Nightly audit",
  timing: { type: "cron", expression: "0 6 * * 1-5" },
  timeZone: "Europe/London",
  execution,
  state: "enabled",
  nextOccurrenceAt: "2026-08-21T05:00:00.000Z",
  latestHistory: null,
  unacknowledgedFailure: false,
  createdAt: now,
  updatedAt: now,
  revision: 1,
  prompt: "Audit the dependency tree and report anything unpinned.",
  history: [],
  historyNextCursor: null,
  ...overrides,
});

const summaryOf = (detail: ScheduleDetail): ScheduleSummary => {
  const { prompt: _prompt, history: _history, historyNextCursor: _cursor, ...summary } = detail;
  return summary;
};

const invocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: callingThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["schedules"] as const),
  issuedAt: 1,
} satisfies McpInvocationContext.McpInvocationScope;

/**
 * Runs one handler call against stubbed services with the capability scope
 * provided the way the MCP dispatch path provides it per call. `dispatch`
 * defaults to dying, so a passing read-only test also proves the tool issued no
 * command.
 */
const runHandler = <A, E, R>(
  run: (handlers: Effect.Success<typeof make>) => Effect.Effect<A, E, R>,
  overrides: {
    readonly details?: ReadonlyArray<ScheduleDetail>;
    readonly dispatch?: ScheduleService.ScheduleServiceShape["dispatch"];
    readonly settings?: { readonly enableScheduleManagement?: boolean };
    readonly scope?: McpInvocationContext.McpInvocationScope;
    readonly shell?: Option.Option<OrchestrationThreadShell>;
  } = {},
) => {
  const details = overrides.details ?? [scheduleDetail()];
  return Effect.gen(function* () {
    const handlers = yield* make;
    return yield* run(handlers);
  }).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      overrides.scope ?? invocationScope,
    ),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        serverSettingsLayerTest({
          enableScheduleManagement: overrides.settings?.enableScheduleManagement ?? true,
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.succeed(overrides.shell ?? Option.some(callingShell)),
        }),
        Layer.mock(ScheduleService.ScheduleService)({
          getSnapshot: () =>
            Effect.succeed({
              sequence: 1,
              schedules: details.map(summaryOf),
              updatedAt: now,
            }),
          getDetail: (scheduleId) => {
            const found = details.find((detail) => detail.id === scheduleId);
            return found === undefined
              ? Effect.fail(
                  new ScheduleOperationError({
                    message: `Schedule ${scheduleId} was not found.`,
                    failure: "not_found",
                    scheduleId,
                  }),
                )
              : Effect.succeed(found);
          },
          dispatch:
            overrides.dispatch ??
            (() => Effect.die("schedules.dispatch must not be called by a read-only tool")),
        }),
      ),
    ),
  );
};

/** Day of week (0 = Sunday) without constructing a Date inside Effect code. */
const utcWeekday = (instant: string) => (Math.floor(Date.parse(instant) / 86_400_000) + 4) % 7;

/**
 * Captures dispatched commands and applies them to `details`, so a handler that
 * reads its own write back sees the write — the read-back is where patch
 * merging and the returned occurrence preview actually get proved.
 */
const recordingDispatch = (details: Array<ScheduleDetail>) => {
  const commands: Array<ScheduleCommand> = [];
  const replace = (scheduleId: ScheduleId, changes: Partial<ScheduleDetail>) => {
    const index = details.findIndex((detail) => detail.id === scheduleId);
    if (index >= 0) details[index] = { ...(details[index] as ScheduleDetail), ...changes };
  };
  const dispatch: ScheduleService.ScheduleServiceShape["dispatch"] = (command) => {
    commands.push(command);
    switch (command.type) {
      case "schedule.create":
        details.push(
          scheduleDetail({
            id: command.scheduleId,
            projectId: command.projectId,
            name: command.name,
            prompt: command.prompt,
            timing: command.timing,
            timeZone: command.timeZone,
            execution: command.execution,
            state: command.state,
          }),
        );
        break;
      case "schedule.update":
        replace(command.scheduleId, {
          name: command.name,
          prompt: command.prompt,
          timing: command.timing,
          timeZone: command.timeZone,
          execution: command.execution,
        });
        break;
      case "schedule.pause":
        replace(command.scheduleId, { state: "paused" });
        break;
      case "schedule.resume":
        replace(command.scheduleId, { state: "enabled" });
        break;
      case "schedule.run-now": {
        const existing = details.find((detail) => detail.id === command.scheduleId);
        replace(command.scheduleId, {
          history: [
            {
              type: "triggered",
              occurrenceId: command.occurrenceId,
              scheduledFor: now,
              triggeredAt: now,
              threadId: triggeredThreadId,
            },
            ...(existing?.history ?? []),
          ],
        });
        break;
      }
      default:
        break;
    }
    return Effect.succeed({ sequence: 2, scheduleId: command.scheduleId });
  };
  return { commands, dispatch };
};

describe("list_schedules", () => {
  it.effect("scopes to the calling session's project by default", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_schedules({}), {
        details: [
          scheduleDetail(),
          scheduleDetail({
            id: ScheduleId.make("schedule-other"),
            projectId: otherProjectId,
            name: "Someone else's job",
          }),
        ],
      });

      expect(result.schedules.map((schedule) => schedule.scheduleId)).toEqual(["schedule-1"]);
      expect(result.callingProjectId).toBe(ownProjectId);
    }),
  );

  it.effect("widens to every project when asked", () =>
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.list_schedules({ allProjects: true }),
        {
          details: [
            scheduleDetail(),
            scheduleDetail({
              id: ScheduleId.make("schedule-other"),
              projectId: otherProjectId,
              name: "Someone else's job",
            }),
          ],
        },
      );

      expect(result.schedules).toHaveLength(2);
    }),
  );

  it.effect("renders the cadence in plain language, not as cron", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_schedules({}));

      expect(result.schedules[0]?.cadence).toBe("Weekdays at 06:00");
    }),
  );

  it.effect("filters by state", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) => handlers.list_schedules({ state: "paused" }), {
        details: [
          scheduleDetail(),
          scheduleDetail({ id: ScheduleId.make("schedule-2"), state: "paused" }),
        ],
      });

      expect(result.schedules.map((schedule) => schedule.scheduleId)).toEqual(["schedule-2"]);
    }),
  );
});

describe("get_schedule", () => {
  it.effect("truncates a long prompt and reports its true length", () =>
    Effect.gen(function* () {
      const prompt = "x".repeat(10_000);
      const result = yield* runHandler(
        (handlers) => handlers.get_schedule({ scheduleId: ScheduleId.make("schedule-1") }),
        { details: [scheduleDetail({ prompt })] },
      );

      expect(result.promptTruncated).toBe(true);
      expect(result.promptLength).toBe(10_000);
      expect(result.prompt.length).toBeLessThan(5_000);
    }),
  );

  it.effect("leaves a short prompt intact", () =>
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) =>
        handlers.get_schedule({ scheduleId: ScheduleId.make("schedule-1") }),
      );

      expect(result.promptTruncated).toBe(false);
      expect(result.prompt).toBe("Audit the dependency tree and report anything unpinned.");
    }),
  );

  it.effect("reads a Schedule belonging to another project", () =>
    // Reads may look wider than writes: answering "what have I got scheduled"
    // must not depend on which project the session happens to be in.
    Effect.gen(function* () {
      const result = yield* runHandler(
        (handlers) => handlers.get_schedule({ scheduleId: ScheduleId.make("schedule-other") }),
        {
          details: [
            scheduleDetail({
              id: ScheduleId.make("schedule-other"),
              projectId: otherProjectId,
            }),
          ],
        },
      );

      expect(result.projectId).toBe(otherProjectId);
    }),
  );

  it.effect("passes a domain not_found through with its failure code intact", () =>
    Effect.gen(function* () {
      const error = yield* runHandler((handlers) =>
        handlers.get_schedule({ scheduleId: ScheduleId.make("missing") }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationDomainError");
      expect(error).toMatchObject({ failure: "not_found" });
    }),
  );
});

describe("create_schedule", () => {
  it.effect("derives the project from the calling session and inherits its execution", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Morning sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "0 6 * * *" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands[0]).toMatchObject({
        type: "schedule.create",
        projectId: ownProjectId,
        state: "enabled",
        execution: {
          modelSelection: { model: "claude-opus" },
          runtimeMode: "full-access",
          // The calling session has no worktree, so the Schedule inherits local.
          workspaceMode: "local",
        },
      });
      expect(result.projectId).toBe(ownProjectId);
      expect(result.state).toBe("enabled");
    }),
  );

  it.effect("defaults the time zone to the server's own and echoes it back", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Morning sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "0 6 * * *" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(recorder.commands[0]).toMatchObject({ timeZone: serverZone });
      // Echoed back so the agent can say "6am Europe/London", not just "done".
      expect(result.timeZone).toBe(serverZone);
    }),
  );

  it.effect("honours an explicit time zone and execution overrides", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Morning sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "0 6 * * *" },
            timeZone: "America/New_York",
            workspaceMode: "worktree",
            model: "claude-sonnet",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands[0]).toMatchObject({
        timeZone: "America/New_York",
        execution: {
          workspaceMode: "worktree",
          modelSelection: { model: "claude-sonnet" },
        },
      });
      expect(result.timeZone).toBe("America/New_York");
    }),
  );

  it.effect("returns upcoming occurrences so the agent can read the cadence back", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Weekday sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "0 6 * * 1-5" },
            timeZone: "Europe/London",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(result.cadence).toBe("Weekdays at 06:00");
      expect(result.upcomingOccurrences).toHaveLength(5);
      // Every one lands on a weekday, which is the mistake the preview exists
      // to catch: "0 6 * * 1,5" would put Saturdays and Sundays in this list.
      for (const occurrence of result.upcomingOccurrences) {
        expect(utcWeekday(occurrence)).toBeGreaterThanOrEqual(1);
        expect(utcWeekday(occurrence)).toBeLessThanOrEqual(5);
      }
      expect(result.frequencyWarning).toBeNull();
    }),
  );

  it.effect("warns about the thread count when the cadence is aggressive", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Constant sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "*/5 * * * *" },
            timeZone: "Europe/London",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(result.cadence).toBe("Every 5 minutes");
      expect(result.frequencyWarning).toContain("288");
    }),
  );

  it.effect("does not inflate the run count for an office-hours cadence", () =>
    // Ten minutes apart, but only between 09:00 and 17:59: 54 runs a day, well
    // under the warning threshold. Reading the rate off the first few gaps
    // instead reports 144/day and puts that number in front of the user.
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Office hours sweep",
            prompt: "Sweep the inbox.",
            timing: { type: "cron", expression: "*/10 9-17 * * *" },
            timeZone: "Europe/London",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(result.frequencyWarning).toBeNull();
    }),
  );

  it.effect("refuses a name already used by a live Schedule in the same project", () =>
    Effect.gen(function* () {
      const error = yield* runHandler((handlers) =>
        handlers.create_schedule({
          name: "  nightly AUDIT ",
          prompt: "Do it again.",
          timing: { type: "cron", expression: "0 6 * * *" },
        }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationNameConflictError");
      // The existing Schedule's id, so the agent can switch to update_schedule
      // instead of leaving a duplicate it has no way to delete.
      expect(error).toMatchObject({ scheduleId: "schedule-1", name: "Nightly audit" });
    }),
  );

  it.effect("allows reusing the name of a completed Schedule", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail({ state: "completed" })];
      const recorder = recordingDispatch(details);
      yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Nightly audit",
            prompt: "Do it again.",
            timing: { type: "cron", expression: "0 6 * * *" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands[0]?.type).toBe("schedule.create");
    }),
  );

  it.effect("allows the same name in a different project", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail({ projectId: otherProjectId })];
      const recorder = recordingDispatch(details);
      yield* runHandler(
        (handlers) =>
          handlers.create_schedule({
            name: "Nightly audit",
            prompt: "Do it again.",
            timing: { type: "cron", expression: "0 6 * * *" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands[0]?.type).toBe("schedule.create");
    }),
  );
});

describe("update_schedule", () => {
  it.effect("keeps every field the caller did not send", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail()];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.update_schedule({
            scheduleId: ScheduleId.make("schedule-1"),
            timing: { type: "cron", expression: "0 7 * * 1" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands[0]).toMatchObject({
        type: "schedule.update",
        name: "Nightly audit",
        // The prompt the agent never read survives the edit verbatim.
        prompt: "Audit the dependency tree and report anything unpinned.",
        timeZone: "Europe/London",
        timing: { expression: "0 7 * * 1" },
        execution: { workspaceMode: "worktree" },
      });
      expect(result.cadence).toBe("Mondays at 07:00");
    }),
  );

  it.effect("still warns about an aggressive cadence on a paused Schedule", () =>
    // The warning is a property of the cadence, not of the current state. A
    // user who resumes this from the Schedules page never sees the projection
    // again, so suppressing it here is how a Schedule quietly becomes a flood.
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail({ state: "paused" })];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.update_schedule({
            scheduleId: ScheduleId.make("schedule-1"),
            timing: { type: "cron", expression: "*/5 * * * *" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(result.state).toBe("paused");
      expect(result.frequencyWarning).toContain("288");
    }),
  );

  it.effect("refuses a rename onto another live Schedule's name", () =>
    // create_schedule refuses this duplicate, so update must too — otherwise
    // the invariant is one rename away from broken, and there is no delete tool
    // to clean up after it.
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) =>
          handlers.update_schedule({
            scheduleId: ScheduleId.make("schedule-2"),
            name: "nightly AUDIT",
          }),
        {
          details: [
            scheduleDetail(),
            scheduleDetail({ id: ScheduleId.make("schedule-2"), name: "Weekly sweep" }),
          ],
        },
      ).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationNameConflictError");
      expect(error).toMatchObject({ scheduleId: "schedule-1" });
    }),
  );

  it.effect("allows a Schedule to keep its own name through an unrelated edit", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail()];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.update_schedule({
            scheduleId: ScheduleId.make("schedule-1"),
            name: "Nightly audit",
            timing: { type: "cron", expression: "0 7 * * 1" },
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(result.name).toBe("Nightly audit");
    }),
  );

  it.effect("refuses to change a Schedule in another project", () =>
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) =>
          handlers.update_schedule({
            scheduleId: ScheduleId.make("schedule-other"),
            name: "Hijacked",
          }),
        {
          details: [
            scheduleDetail({
              id: ScheduleId.make("schedule-other"),
              projectId: otherProjectId,
            }),
          ],
        },
      ).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationDeniedError");
      expect(error).toMatchObject({ reason: "not_in_calling_project" });
    }),
  );

  it.effect("rejects an update that changes nothing", () =>
    Effect.gen(function* () {
      const error = yield* runHandler((handlers) =>
        handlers.update_schedule({ scheduleId: ScheduleId.make("schedule-1") }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationInvalidInputError");
    }),
  );
});

describe("set_schedule_state", () => {
  it.effect("pauses through the pause command rather than an update", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail()];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.set_schedule_state({
            scheduleId: ScheduleId.make("schedule-1"),
            state: "paused",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands.map((command) => command.type)).toEqual(["schedule.pause"]);
      expect(result.state).toBe("paused");
    }),
  );

  it.effect("resumes a paused Schedule", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail({ state: "paused" })];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) =>
          handlers.set_schedule_state({
            scheduleId: ScheduleId.make("schedule-1"),
            state: "enabled",
          }),
        { details, dispatch: recorder.dispatch },
      );

      expect(recorder.commands.map((command) => command.type)).toEqual(["schedule.resume"]);
      expect(result.state).toBe("enabled");
    }),
  );

  it.effect("dispatches nothing when the Schedule is already in that state", () =>
    // The default dispatch dies, so reaching a result at all proves this.
    Effect.gen(function* () {
      const result = yield* runHandler((handlers) =>
        handlers.set_schedule_state({
          scheduleId: ScheduleId.make("schedule-1"),
          state: "enabled",
        }),
      );

      expect(result.state).toBe("enabled");
    }),
  );
});

describe("run_schedule_now", () => {
  it.effect("returns the thread the manual run started", () =>
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail()];
      const recorder = recordingDispatch(details);
      const result = yield* runHandler(
        (handlers) => handlers.run_schedule_now({ scheduleId: ScheduleId.make("schedule-1") }),
        { details, dispatch: recorder.dispatch },
      );

      const command = recorder.commands[0];
      expect(command?.type).toBe("schedule.run-now");
      expect(result.threadId).toBe(triggeredThreadId);
      if (command?.type === "schedule.run-now") {
        expect(result.occurrenceId).toBe(command.occurrenceId);
      }
      // A manual run is a write, so its result carries what every other write
      // carries — otherwise its chat row renders as a bare heading.
      expect(result.cadence).toBe("Weekdays at 06:00");
      expect(result.timeZone).toBe("Europe/London");
    }),
  );

  it.effect("reports a null thread when the run left no matching history entry", () =>
    // The occurrence is still underway; claiming an unrelated thread would be
    // worse than admitting the run has not landed yet.
    Effect.gen(function* () {
      const details: Array<ScheduleDetail> = [scheduleDetail()];
      const result = yield* runHandler(
        (handlers) => handlers.run_schedule_now({ scheduleId: ScheduleId.make("schedule-1") }),
        {
          details,
          dispatch: (command) => Effect.succeed({ sequence: 2, scheduleId: command.scheduleId }),
        },
      );

      expect(result.threadId).toBeNull();
    }),
  );

  it.effect("refuses to trigger a Schedule in another project", () =>
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) => handlers.run_schedule_now({ scheduleId: ScheduleId.make("schedule-other") }),
        {
          details: [
            scheduleDetail({
              id: ScheduleId.make("schedule-other"),
              projectId: otherProjectId,
            }),
          ],
        },
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "not_in_calling_project" });
    }),
  );
});

describe("capability and settings gates", () => {
  it.effect("denies every tool when the credential lacks the schedules capability", () =>
    Effect.gen(function* () {
      const error = yield* runHandler((handlers) => handlers.list_schedules({}), {
        scope: { ...invocationScope, capabilities: new Set(["sessions"] as const) },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "capability_unavailable" });
    }),
  );

  it.effect("denies reads as well as writes when the setting is off", () =>
    Effect.gen(function* () {
      const error = yield* runHandler(
        (handlers) => handlers.get_schedule({ scheduleId: ScheduleId.make("schedule-1") }),
        { settings: { enableScheduleManagement: false } },
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "disabled_in_settings" });
    }),
  );

  it.effect("reports an unreadable calling thread rather than guessing a project", () =>
    Effect.gen(function* () {
      const error = yield* runHandler((handlers) => handlers.list_schedules({}), {
        shell: Option.none(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("ScheduleOrchestrationOperationError");
    }),
  );
});
