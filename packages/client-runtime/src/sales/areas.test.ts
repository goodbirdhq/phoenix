import {
  SalesAutopilotToday,
  SalesMailboxList,
  type SalesAutopilotItem,
  type SalesMailbox,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { autopilotTimeline } from "./autopilot.ts";
import { healthLines, mailboxState, poolLine } from "./mailboxes.ts";
import { groupTasks, inviteBudgetLine, taskDueLabel } from "./tasks.ts";
import { salesTime } from "./time.ts";

const decodeAutopilot = Schema.decodeUnknownSync(SalesAutopilotToday);
const decodeMailboxes = Schema.decodeUnknownSync(SalesMailboxList);

const autopilotItems = (
  rows: ReadonlyArray<{ state: string; approval: string | null }>,
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
    { state: "paused-by-a-later-engine", approval: "route" },
  ]);

  it("shows automated sends only, and says how many pressed ones it left out", () => {
    const timeline = autopilotTimeline(items, false);
    expect(timeline.groups.map((group) => [group.state, group.items.length])).toEqual([
      ["failed", 1],
      ["sent", 2],
      ["other", 1],
    ]);
    expect(timeline).toMatchObject({ shown: 4, pressedHidden: 1 });
  });

  it("takes pressed sends in when asked", () => {
    const timeline = autopilotTimeline(items, true);
    expect(timeline.groups.map((group) => group.state)).toEqual([
      "failed",
      "scheduled",
      "sent",
      "other",
    ]);
    expect(timeline).toMatchObject({ shown: 5, pressedHidden: 0 });
  });
});

describe("salesTime", () => {
  const options = { localZone: "America/Los_Angeles", locale: "en-US" } as const;
  const now = Date.parse("2026-11-09T18:30:00.000Z");

  it("adds the contact's clock when it reads differently", () => {
    expect(
      salesTime("2026-11-09T17:23:00.000Z", now, { ...options, theirZone: "Europe/London" }),
    ).toEqual({ local: "9:23 AM", theirs: "5:23 PM their time" });
  });

  it("leaves it out for a contact on the viewer's clock, or with no zone it knows", () => {
    for (const theirZone of ["America/Los_Angeles", "Not/AZone", null]) {
      expect(salesTime("2026-11-09T17:23:00.000Z", now, { ...options, theirZone })?.theirs).toBe(
        null,
      );
    }
  });

  it("names the day when it is not today, on either clock", () => {
    const tokyo = { ...options, theirZone: "Asia/Tokyo" };
    expect(salesTime("2026-11-10T07:00:00.000Z", now, tokyo)).toEqual({
      local: "11:00 PM",
      theirs: "Tue 4:00 PM their time",
    });
    expect(salesTime("2026-11-10T09:00:00.000Z", now, tokyo)).toEqual({
      local: "Tue 1:00 AM",
      theirs: "6:00 PM their time",
    });
  });

  it("reads nothing into a missing time", () => {
    expect(salesTime(null, now)).toBeNull();
    expect(salesTime("not a time", now)).toBeNull();
  });
});

describe("tasks", () => {
  it("reads due days against the engine's today", () => {
    expect(taskDueLabel("2026-11-09", "2026-11-09")).toBe("Due today");
    expect(taskDueLabel("2026-11-05", "2026-11-09")).toMatch(/^Overdue since /);
    expect(taskDueLabel("2026-11-12", "2026-11-09")).toMatch(/^Due /);
    expect(taskDueLabel(null, "2026-11-09")).toBeNull();
  });

  it("splits cards on Slack from tasks not posted yet", () => {
    const task = (id: string, status: string) =>
      ({ id, status }) as Parameters<typeof groupTasks>[0][number];
    const groups = groupTasks([task("a", "posted"), task("b", "pending"), task("c", "posted")]);
    expect(groups.ready.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups.upcoming.map((item) => item.id)).toEqual(["b"]);
  });

  it("says the invite budget only when the engine gives one", () => {
    expect(inviteBudgetLine({ day: null, dailyLimit: 7, available: 1 })).toBe(
      "1 of 7 invites left today",
    );
    expect(inviteBudgetLine({ day: null, dailyLimit: null, available: null })).toBeNull();
  });
});

describe("mailboxes", () => {
  const list = decodeMailboxes({
    generatedAt: "2026-11-09T18:30:00.000Z",
    bounceRule: { window: 20, threshold: 3 },
    items: [
      { address: "a@x.example", status: "active", lastSyncedAt: "2026-11-09T18:00:00.000Z" },
      { address: "b@x.example", status: "benched", lastSyncedAt: "2026-11-09T12:00:00.000Z" },
      { address: "c@x.example", status: "active", hardBouncesInWindow: 2 },
      { address: "d@x.example", status: "retired" },
    ],
  });
  const now = Date.parse("2026-11-09T18:30:00.000Z");
  const byAddress = (address: string): SalesMailbox =>
    list.items.find((item) => item.address === address)!;

  it("flags a sync hours behind, or that never finished, except on a retired mailbox", () => {
    const stale = (address: string) =>
      mailboxState(byAddress(address), list.bounceRule, now).syncStale;
    expect([stale("a@x.example"), stale("b@x.example"), stale("c@x.example")]).toEqual([
      false,
      true,
      true,
    ]);
    expect(stale("d@x.example")).toBe(false);
  });

  it("warns one hard bounce before the engine benches an active mailbox", () => {
    expect(mailboxState(byAddress("c@x.example"), list.bounceRule, now).nearBench).toBe(true);
    expect(mailboxState(byAddress("a@x.example"), list.bounceRule, now).nearBench).toBe(false);
  });

  it("puts the next send after the rest, and drops a rest that is over", () => {
    const mailbox = {
      ...byAddress("a@x.example"),
      restUntil: "2026-11-09T18:40:00.000Z",
      nextSlotAt: "2026-11-09T18:35:00.000Z",
    };
    expect(mailboxState(mailbox, list.bounceRule, now)).toMatchObject({
      restingUntil: "2026-11-09T18:40:00.000Z",
      nextSendAt: "2026-11-09T18:40:00.000Z",
    });
    const rested = { ...mailbox, restUntil: "2026-11-09T18:00:00.000Z" };
    expect(mailboxState(rested, list.bounceRule, now)).toMatchObject({
      restingUntil: null,
      nextSendAt: "2026-11-09T18:35:00.000Z",
    });
  });

  it("sums the pool by status in the order mailboxes move through", () => {
    expect(poolLine(list.items)).toBe("2 active, 1 benched, 1 retired");
    expect(poolLine([])).toBe("No mailboxes");
  });

  it("reads the health message as plain lines", () => {
    expect(healthLines("Engine needs a look: 3 sent.\nFirst: Q&amp;A &lt;draft&gt;\n\n")).toEqual([
      "Engine needs a look: 3 sent.",
      "First: Q&A <draft>",
    ]);
  });
});
