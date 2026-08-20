function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const text = asTrimmedString(value);
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Digs the write result out of whichever shape a provider reported it in. */
function scheduleResult(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value) ?? parseJsonRecord(value);
  if (!direct) return undefined;
  if (asTrimmedString(direct.scheduleId)) return direct;

  for (const key of ["structuredContent", "structured_content"]) {
    const structured = asRecord(direct[key]) ?? parseJsonRecord(direct[key]);
    if (structured && asTrimmedString(structured.scheduleId)) return structured;
  }

  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = parseJsonRecord(asRecord(block)?.text);
      if (parsed && asTrimmedString(parsed.scheduleId)) return parsed;
    }
  }
  return undefined;
}

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

export type ScheduleToolAction = "created" | "updated" | "paused" | "enabled" | "ran";

export interface ScheduleToolActivity {
  readonly action: ScheduleToolAction;
  readonly scheduleId: string;
  readonly name: string;
  readonly state: string;
  readonly timeZone: string;
  readonly cadence: string;
  readonly nextOccurrenceAt: string | null;
  readonly projectId: string;
}

function actionFor(tool: string, state: string | undefined): ScheduleToolAction {
  switch (tool) {
    case "create_schedule":
      return "created";
    case "update_schedule":
      return "updated";
    case "run_schedule_now":
      return "ran";
    default:
      return state === "paused" ? "paused" : "enabled";
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
    const scheduleId = asTrimmedString(projected.scheduleId);
    const name = asTrimmedString(projected.name);
    if (scheduleId !== undefined && name !== undefined) {
      return {
        action: actionFor(tool, asTrimmedString(projected.state)),
        scheduleId,
        name,
        state: asTrimmedString(projected.state) ?? "enabled",
        timeZone: asTrimmedString(projected.timeZone) ?? "",
        cadence: asTrimmedString(projected.cadence) ?? "",
        nextOccurrenceAt: asTrimmedString(projected.nextOccurrenceAt) ?? null,
        projectId: asTrimmedString(projected.projectId) ?? "",
      };
    }
  }

  const result = scheduleResult(item?.result ?? data.result);
  const scheduleId = asTrimmedString(result?.scheduleId);
  const name = asTrimmedString(result?.name);
  // A failed write has no Schedule to point at; the generic tool row, with its
  // error text, says more than a card could.
  if (result === undefined || scheduleId === undefined || name === undefined) return undefined;

  return {
    action: actionFor(tool, asTrimmedString(result.state)),
    scheduleId,
    name,
    state: asTrimmedString(result.state) ?? "enabled",
    timeZone: asTrimmedString(result.timeZone) ?? "",
    cadence: asTrimmedString(result.cadence) ?? "",
    nextOccurrenceAt: asTrimmedString(result.nextOccurrenceAt) ?? null,
    projectId: asTrimmedString(result.projectId) ?? "",
  };
}
