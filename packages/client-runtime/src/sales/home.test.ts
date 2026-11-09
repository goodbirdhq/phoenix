import { SalesSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildSalesHome } from "./home.ts";

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
        replies: { awaitingAnswer: 1 },
        mailboxes: { active: 8 },
        sendsToday: { cold: 1, coldCap: 42 },
        dispatcher: quietDispatcher,
      }),
    );
    expect(home.needsYou).toBe(5);
    expect(home.headline).toBe("5 things need you");
    expect(home.areas.map((area) => [area.key, area.count])).toEqual([
      ["sourcing", null],
      ["outreach", 2],
      ["autopilot", 1],
      ["todo", 1],
      ["conversations", 1],
    ]);
    expect(home.areas[3]?.figures).toContainEqual({ label: "Invites left", value: "1 of 7" });
    expect(home.health).toEqual({
      ok: true,
      line: "8 mailboxes active · 1 of 42 cold sends today",
    });
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
