import {
  CreateScheduleInput,
  GetScheduleInput,
  GetScheduleResult,
  ListSchedulesInput,
  ListSchedulesResult,
  RunScheduleNowInput,
  RunScheduleNowResult,
  SCHEDULE_PROMPT_PREVIEW_CHARS,
  ScheduleOrchestrationError,
  ScheduleWriteResult,
  SetScheduleStateInput,
  UpdateScheduleInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const ListSchedulesTool = Tool.make("list_schedules", {
  description:
    "List this environment's Schedules — recurring or one-time prompts that start a fresh agent thread when they fire. Defaults to the calling session's own project; pass allProjects: true when the user asks about all of their automation. Pass state to return only Schedules in one state. Each entry carries the Schedule's id, name, state (enabled, paused, completed, or failed), its cadence in plain language, the raw timing, its time zone, when it next runs, and whether it has an unacknowledged failure. Prompts are not included — use get_schedule for that.",
  parameters: ListSchedulesInput,
  success: ListSchedulesResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "List schedules")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GetScheduleTool = Tool.make("get_schedule", {
  description: `Read one Schedule in full, by scheduleId: everything list_schedules returns, plus its prompt, its recent history, and its next few occurrences. History is how you answer "why didn't my nightly job run" — triggered entries carry the threadId of the thread that ran, so you can go read what actually happened; failed entries carry a code, a message, and a repeat count; skipped entries mean the environment was not running when the Schedule was due. The prompt is truncated at ${SCHEDULE_PROMPT_PREVIEW_CHARS.toLocaleString()} characters, with promptLength and promptTruncated reporting the true size — you never need the whole prompt to edit a Schedule, since update_schedule only changes the fields you pass.`,
  parameters: GetScheduleInput,
  success: GetScheduleResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Read schedule")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const CreateScheduleTool = Tool.make("create_schedule", {
  description:
    'Create a Schedule in the calling session\'s project. Pass a name, the prompt each run should start its new thread with, and timing. Timing is either {type: "cron", expression} using a standard five-field cron expression, or {type: "one-time", runAt} with a future ISO instant; recurring Schedules must be at least five minutes apart. timeZone is an IANA zone and decides what the cron expression means — omit it to use the server environment\'s own zone, which is usually what the user means by "6am", and read the resolved zone back from the result. Execution settings are inherited from the calling session (its provider, model, runtime and workspace mode), so the Schedule runs the way you are running now; override model or workspaceMode when the user asks for something different — a recurring Schedule usually wants workspaceMode "worktree" so its runs cannot collide with live work. The Schedule is created enabled and will fire on its next occurrence. ALWAYS read the returned upcomingOccurrences and cadence back to the user: "0 6 * * 1-5" and "0 6 * * 1,5" differ by one character and mean weekdays versus Mondays-and-Fridays, and the difference is otherwise invisible until the wrong day. Each firing starts a brand-new thread and consumes provider quota. Names must be unique within the project; a collision is refused and names the existing Schedule so you can switch to update_schedule.',
  parameters: CreateScheduleInput,
  success: ScheduleWriteResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Create schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const UpdateScheduleTool = Tool.make("update_schedule", {
  description:
    "Change an existing Schedule in the calling session's project, named by scheduleId. Pass any of name, prompt, timing, timeZone, model, workspaceMode, or baseBranch; only the fields you pass are changed; everything else is kept as-is, so you can move a Schedule to a new time without resending its prompt. Use set_schedule_state to pause or resume — this tool does not change state. As with create_schedule, read the returned cadence and upcomingOccurrences back to the user to confirm the new timing means what they asked for.",
  parameters: UpdateScheduleInput,
  success: ScheduleWriteResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Update schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SetScheduleStateTool = Tool.make("set_schedule_state", {
  description:
    'Pause or resume a Schedule in the calling session\'s project, named by scheduleId. Pass state: "paused" or "enabled". "paused" stops it firing while keeping it and its history intact; "enabled" starts it firing again from its next occurrence. Pausing is the reversible way to stop a Schedule the user no longer wants — this toolkit deliberately cannot delete Schedules, so if the user wants one gone for good, pause it and tell them it is still listed on the Schedules page where they can delete it. Completed and failed Schedules cannot be resumed.',
  parameters: SetScheduleStateInput,
  success: ScheduleWriteResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Pause or resume schedule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const RunScheduleNowTool = Tool.make("run_schedule_now", {
  description:
    "Trigger a Schedule, named by scheduleId, immediately — without waiting for its next occurrence, and without changing its timing. This starts a real thread doing real work with the Schedule's prompt, exactly as a scheduled firing would — it is how you verify a Schedule you just created actually does what the user wanted, not a dry run. A one-time Schedule is not marked completed by a manual run. The result carries the threadId of the thread that started, so you can check on it or hand the user a link.",
  parameters: RunScheduleNowInput,
  success: RunScheduleNowResult,
  failure: ScheduleOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Run schedule now")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SchedulesToolkit = Toolkit.make(
  ListSchedulesTool,
  GetScheduleTool,
  CreateScheduleTool,
  UpdateScheduleTool,
  SetScheduleStateTool,
  RunScheduleNowTool,
);
