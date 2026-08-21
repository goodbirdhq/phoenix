import { asRecord, asTrimmedString, findResultRecord } from "./toolActivityPayload.ts";

/**
 * Schedule writes that leave a card. Reads change nothing, so they stay generic
 * work-log rows rather than adding noise to the transcript.
 */
const WRITE_TOOLS = new Set([
  "create_schedule",
  "update_schedule",
  "set_schedule_state",
  "run_schedule_now",
]);

function scheduleToolName(
  data: Record<string, unknown>,
  item: Record<string, unknown>,
): string | undefined {
  const server = asTrimmedString(item.server)?.toLowerCase();
  const itemTool = asTrimmedString(item.tool)?.toLowerCase();
  if (server === "phoenix" && itemTool !== undefined && WRITE_TOOLS.has(itemTool)) {
    return itemTool;
  }
  const flattened = asTrimmedString(data.toolName)?.toLowerCase();
  const suffix = flattened?.startsWith("mcp__phoenix__")
    ? flattened.slice("mcp__phoenix__".length)
    : undefined;
  return suffix !== undefined && WRITE_TOOLS.has(suffix) ? suffix : undefined;
}

export type ScheduleToolAction = "created" | "updated" | "paused" | "resumed" | "ran";

export interface ScheduleToolActivity {
  readonly action: ScheduleToolAction;
  readonly name: string;
  readonly state: string;
  readonly timeZone: string;
  readonly cadence: string;
  readonly nextOccurrenceAt: string | null;
}

/** Headings both surfaces render for a Schedule write. */
export const SCHEDULE_ACTION_LABELS: Record<ScheduleToolAction, string> = {
  created: "Created schedule",
  updated: "Updated schedule",
  paused: "Paused schedule",
  resumed: "Resumed schedule",
  ran: "Ran schedule now",
};

function actionFor(tool: string, state: string | undefined): ScheduleToolAction {
  switch (tool) {
    case "create_schedule":
      return "created";
    case "update_schedule":
      return "updated";
    case "run_schedule_now":
      return "ran";
    default:
      return state === "paused" ? "paused" : "resumed";
  }
}

/**
 * Recognizes a Phoenix Schedule write across provider payload shapes and
 * reduces it to the handful of fields a chat card renders.
 *
 * Reads `data.scheduleActivity` first: the server slims MCP results down to an
 * 84-character preview before they reach a client, which would cut the
 * Schedule's id and cadence out of the result entirely, so it carries this
 * derived form explicitly in that field. Raw provider payloads (server-side,
 * and pre-slimming clients) still resolve from `result` below.
 */
export function deriveScheduleToolActivity(value: unknown): ScheduleToolActivity | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const item = asRecord(data.item);
  const tool = scheduleToolName(data, item ?? {});
  if (tool === undefined) return undefined;

  const projected = asRecord(data.scheduleActivity);
  if (projected !== undefined) {
    const name = asTrimmedString(projected.name);
    if (name !== undefined) {
      return {
        action: actionFor(tool, asTrimmedString(projected.state)),
        name,
        state: asTrimmedString(projected.state) ?? "enabled",
        timeZone: asTrimmedString(projected.timeZone) ?? "",
        cadence: asTrimmedString(projected.cadence) ?? "",
        nextOccurrenceAt: asTrimmedString(projected.nextOccurrenceAt) ?? null,
      };
    }
  }

  // scheduleId is the success signal rather than a rendered field: a failed
  // write has no Schedule to point at, and the generic tool row, with its error
  // text, says more than a card could.
  const result = findResultRecord(item?.result ?? data.result, "scheduleId");
  const name = asTrimmedString(result?.name);
  if (result === undefined || name === undefined) return undefined;

  return {
    action: actionFor(tool, asTrimmedString(result.state)),
    name,
    state: asTrimmedString(result.state) ?? "enabled",
    timeZone: asTrimmedString(result.timeZone) ?? "",
    cadence: asTrimmedString(result.cadence) ?? "",
    nextOccurrenceAt: asTrimmedString(result.nextOccurrenceAt) ?? null,
  };
}
