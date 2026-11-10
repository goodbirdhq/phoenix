import { SalesAutopilotToday, type SalesAutopilotItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { autopilotDetail, autopilotTimeline, outOfOfficeLabel } from "./autopilot.ts";

const decodeAutopilot = Schema.decodeUnknownSync(SalesAutopilotToday);

const autopilotItems = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<SalesAutopilotItem> =>
  decodeAutopilot({
    generatedAt: "2026-11-09T18:30:00.000Z",
    items: rows.map((row, index) => ({ activityId: `act-${index}`, ...row })),
  }).items;

describe("autopilotTimeline", () => {
  const items = autopilotItems([
    { state: "sent", approval: "route" },
    { state: "scheduled", approval: "press" },
    { state: "failed", approval: "route" },
    { state: "sent", approval: null },
    { state: "paused", approval: "route", paused: { by: "phoenix", at: "2026-11-09T17:00:00Z" } },
    { state: "held", approval: "route" },
    { state: "made-up-by-a-later-engine", approval: "route" },
  ]);

  it("shows automated sends only, and says how many pressed ones it left out", () => {
    const timeline = autopilotTimeline(items, false);
    expect(timeline.groups.map((group) => [group.label, group.items.length])).toEqual([
      ["Failed", 1],
      ["Held by the engine", 1],
      ["Paused", 1],
      ["Sent", 2],
      ["Other", 1],
    ]);
    expect(timeline).toMatchObject({ shown: 6, pressedHidden: 1 });
  });

  it("takes pressed sends in when asked", () => {
    const timeline = autopilotTimeline(items, true);
    expect(timeline.groups.map((group) => group.state)).toEqual([
      "failed",
      "held",
      "paused",
      "scheduled",
      "sent",
      "other",
    ]);
    expect(timeline).toMatchObject({ shown: 7, pressedHidden: 0 });
  });

  it("reads who paused a send, and an engine that sends no pause at all", () => {
    expect(items.find((item) => item.state === "paused")?.paused?.by).toBe("phoenix");
    expect(items.find((item) => item.state === "held")?.paused).toBeNull();
  });
});

describe("autopilot rows", () => {
  it("says which email, from where, and who approved it", () => {
    const [item] = autopilotItems([
      { state: "scheduled", approval: "press", step: 2, campaign: "Fintech Q4", mailbox: "g@x" },
    ]);
    expect(autopilotDetail(item!)).toBe("Email 2 · Fintech Q4 · from g@x · approved by you");
    const [bare] = autopilotItems([{ state: "scheduled", approval: "route" }]);
    expect(autopilotDetail(bare!)).toBe("");
  });

  it("names the day an out-of-office ends, when it gives one", () => {
    expect(outOfOfficeLabel({ returnOn: "2026-11-12", window: "", receivedAt: null })).toMatch(
      /^Away until Thu/,
    );
    expect(outOfOfficeLabel({ returnOn: null, window: "this week", receivedAt: null })).toBe(
      "Out of office",
    );
  });
});
