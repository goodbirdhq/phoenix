import { type SalesLookItem, SalesSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildSalesHome, engineDayNote, lookItemView } from "./home.ts";

const decodeSummary = Schema.decodeUnknownSync(SalesSummary);

const quietDispatcher = {
  lastPokeAt: "2026-11-09T18:28:00.000Z",
  pokeAgeSeconds: 120,
  lastTickAt: "2026-11-09T18:29:00.000Z",
  tickAgeSeconds: 60,
  nextTickAt: "2026-11-09T18:31:00.000Z",
  paused: false,
};

describe("buildSalesHome", () => {
  it("counts what waits on a person and says so in the headline", () => {
    const home = buildSalesHome(
      decodeSummary({
        generatedAt: "2026-11-09T18:30:00.000Z",
        drafts: { awaiting: { total: 2, reply: 1 }, refused: 1 },
        // Refused route chases also sit in drafts.awaiting, so only failures count here.
        autopilotToday: { sent: 1, scheduled: 1, failed: 1, refused: 1 },
        linkedin: { onSlack: 1, pending: 3, budget: { dailyLimit: 7, available: 1 } },
        // One reply has its answer drafted (counted under Outreach), one has none.
        replies: { awaitingAnswer: 2, awaitingAnswerWithoutDraft: 1 },
        mailboxes: { active: 8 },
        sendsToday: { cold: 1, coldCap: 42 },
        dispatcher: quietDispatcher,
      }),
    );
    expect(home.needsYou).toBe(5);
    expect(home.headline).toBe("5 things need you");
    expect(home.areas.map((area) => [area.key, area.count])).toEqual([
      ["outreach", 2],
      ["autopilot", 1],
      ["todo", 1],
      ["conversations", 1],
    ]);
    expect(home.areas[2]?.figures).toContainEqual({ label: "Invites left", value: "1 of 7" });
    expect(home.health).toEqual({
      ok: true,
      line: "8 mailboxes active · 1 of 42 cold sends today",
    });
  });

  it("counts a reply whose answer is drafted once, as a draft waiting", () => {
    const home = buildSalesHome(
      decodeSummary({
        generatedAt: "2026-11-09T18:30:00.000Z",
        drafts: { awaiting: { total: 1, reply: 1 } },
        replies: { awaitingAnswer: 1, awaitingAnswerWithoutDraft: 0 },
        dispatcher: quietDispatcher,
      }),
    );
    expect(home.needsYou).toBe(1);
    expect(home.areas.find((area) => area.key === "conversations")?.status).toBe(
      "1 answer drafted, waiting for approval",
    );
  });

  it("reads an empty summary as nothing to do", () => {
    const home = buildSalesHome(
      decodeSummary({ generatedAt: "2026-11-09T18:30:00.000Z", dispatcher: quietDispatcher }),
    );
    expect(home.headline).toBe("Nothing needs you");
    expect(home.areas.find((area) => area.key === "outreach")?.status).toBe(
      "Nothing waits for approval",
    );
  });

  it("flags a stopped dispatcher, benched mailboxes and items that need a look", () => {
    const home = buildSalesHome(
      decodeSummary({
        generatedAt: "2026-11-09T18:30:00.000Z",
        mailboxes: { active: 7, benched: 1 },
        needsALook: { count: 25, capped: true },
        dispatcher: { ...quietDispatcher, pokeAgeSeconds: 1500 },
      }),
    );
    expect(home.health.ok).toBe(false);
    expect(home.health.line).toBe(
      "Dispatcher looks stopped: last poke 25 min ago · 7 mailboxes active, 1 benched · 0 of 0 cold sends today · 25+ need a look",
    );
  });

  it("calls an overdue next tick a stop even when the last poke is recent", () => {
    const home = buildSalesHome(
      decodeSummary({
        generatedAt: "2026-11-09T18:30:00.000Z",
        dispatcher: { ...quietDispatcher, nextTickAt: "2026-11-09T18:00:00.000Z" },
      }),
    );
    expect(home.health.line).toMatch(/^Dispatcher looks stopped: its next tick is overdue/);
  });
});

describe("lookItemView", () => {
  const look = (patch: Partial<SalesLookItem>): SalesLookItem => ({
    what: "inbound",
    at: null,
    who: null,
    subject: null,
    why: null,
    activityId: null,
    notionUrl: null,
    ...patch,
  });

  it("names the person and subject when the engine sends a name", () => {
    expect(lookItemView(look({ who: "Ada", subject: "Re: hello", why: "Unclassified" }))).toEqual({
      title: "Ada · Re: hello",
      why: "Unclassified",
      notionUrl: null,
    });
  });

  it("never shows a page id as the who, and links the page instead", () => {
    expect(
      lookItemView(
        look({ who: "40fada73-1b2c-4d5e-8f90-1234567890ab", subject: null, why: "No mailbox" }),
      ),
    ).toEqual({
      title: "No mailbox",
      why: null,
      notionUrl: "https://www.notion.so/40fada731b2c4d5e8f901234567890ab",
    });
  });

  it("falls back to what happened when nothing else is known", () => {
    expect(lookItemView(look({ what: "skip" })).title).toBe("A skipped send");
    expect(lookItemView(look({ what: "new-kind" })).title).toBe("Something");
  });
});

describe("engineDayNote", () => {
  // 18:30 UTC: still Nov 9 in London and Los Angeles, already Nov 10 in Tokyo.
  const summary = (timezone: string | null) =>
    decodeSummary({
      generatedAt: "2026-11-09T18:30:00.000Z",
      day: "2026-11-09",
      timezone,
      dispatcher: quietDispatcher,
    });

  it("stays quiet while the engine's day is the viewer's date, whatever its zone", () => {
    expect(engineDayNote(summary("America/Los_Angeles"), "Europe/London")).toBeNull();
    expect(engineDayNote(summary(null), "Europe/London")).toBeNull();
  });

  it("names the engine's day and place when the viewer's date has moved on", () => {
    expect(engineDayNote(summary("America/Los_Angeles"), "Asia/Tokyo")).toMatch(
      /^Engine day .*9.* \(Los Angeles\)$/u,
    );
    expect(engineDayNote(summary(null), "Asia/Tokyo")).toMatch(/^Engine day .*9\D*$/u);
  });
});
