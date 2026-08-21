import { describe, expect, it } from "vite-plus/test";

import { deriveScheduleToolActivity } from "./scheduleToolActivity.ts";

const writeResult = {
  scheduleId: "schedule-1",
  projectId: "project-1",
  name: "Nightly audit",
  state: "enabled",
  timing: { type: "cron", expression: "0 6 * * 1-5" },
  timeZone: "Europe/London",
  cadence: "Weekdays at 06:00",
  nextOccurrenceAt: "2026-08-21T05:00:00.000Z",
  unacknowledgedFailure: false,
  updatedAt: "2026-08-20T09:00:00.000Z",
  upcomingOccurrences: [],
  frequencyWarning: null,
};

const mcpCall = (tool: string, result: unknown) => ({
  item: { type: "mcp_tool_call", server: "phoenix", tool, result },
});

describe("deriveScheduleToolActivity", () => {
  it("derives the card payload from a create result", () => {
    expect(deriveScheduleToolActivity(mcpCall("create_schedule", writeResult))).toEqual({
      action: "created",
      name: "Nightly audit",
      state: "enabled",
      timeZone: "Europe/London",
      cadence: "Weekdays at 06:00",
      nextOccurrenceAt: "2026-08-21T05:00:00.000Z",
    });
  });

  it("labels each write tool with its own action", () => {
    const actionOf = (tool: string) =>
      deriveScheduleToolActivity(mcpCall(tool, writeResult))?.action;

    expect(actionOf("create_schedule")).toBe("created");
    expect(actionOf("update_schedule")).toBe("updated");
    expect(actionOf("run_schedule_now")).toBe("ran");
    expect(actionOf("set_schedule_state")).toBe("resumed");
    expect(
      deriveScheduleToolActivity(mcpCall("set_schedule_state", { ...writeResult, state: "paused" }))
        ?.action,
    ).toBe("paused");
  });

  it("ignores the read-only tools, which change nothing worth a card", () => {
    expect(deriveScheduleToolActivity(mcpCall("list_schedules", writeResult))).toBeUndefined();
    expect(deriveScheduleToolActivity(mcpCall("get_schedule", writeResult))).toBeUndefined();
  });

  it("ignores tool calls from other servers and other toolkits", () => {
    expect(
      deriveScheduleToolActivity({
        item: { type: "mcp_tool_call", server: "somewhere-else", tool: "create_schedule" },
      }),
    ).toBeUndefined();
    expect(deriveScheduleToolActivity(mcpCall("spawn_session", writeResult))).toBeUndefined();
  });

  it("recognises the flattened provider tool name", () => {
    expect(
      deriveScheduleToolActivity({
        toolName: "mcp__phoenix__create_schedule",
        result: writeResult,
      })?.name,
    ).toBe("Nightly audit");
  });

  it("reads a result delivered as JSON text content", () => {
    expect(
      deriveScheduleToolActivity(
        mcpCall("create_schedule", { content: [{ text: JSON.stringify(writeResult) }] }),
      )?.name,
    ).toBe("Nightly audit");
  });

  it("prefers the already-projected carrier field over re-deriving", () => {
    // Clients see the slimmed payload, where `result` is an 84-character
    // preview and this field is the only surviving copy.
    expect(
      deriveScheduleToolActivity({
        item: { type: "mcp_tool_call", server: "phoenix", tool: "create_schedule", result: "Cr…" },
        scheduleActivity: {
          action: "created",
          name: "From the carrier",
          state: "enabled",
          timeZone: "UTC",
          cadence: "Every day at 06:00",
          nextOccurrenceAt: null,
        },
      }),
    ).toMatchObject({ name: "From the carrier", cadence: "Every day at 06:00" });
  });

  it("returns nothing when the result carries no schedule identity", () => {
    // A failed call changes nothing, so it must fall through to the generic row.
    expect(deriveScheduleToolActivity(mcpCall("create_schedule", undefined))).toBeUndefined();
    expect(
      deriveScheduleToolActivity(mcpCall("create_schedule", { error: "name_conflict" })),
    ).toBeUndefined();
  });

  it("carries only what a row renders", () => {
    // This payload rides every Schedule write over the websocket, so an unread
    // field is pure cost. scheduleId stays internal as the success signal.
    const carrier = deriveScheduleToolActivity(mcpCall("create_schedule", writeResult));

    expect(Object.keys(carrier ?? {}).toSorted()).toEqual([
      "action",
      "cadence",
      "name",
      "nextOccurrenceAt",
      "state",
      "timeZone",
    ]);
  });
});
