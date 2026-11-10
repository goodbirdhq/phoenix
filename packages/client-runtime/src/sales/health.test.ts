import { SalesMailboxList, type SalesMailbox } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  healthLines,
  mailboxFacts,
  mailboxState,
  mailboxStatusLabel,
  mailboxStatusTone,
  poolLine,
} from "./health.ts";

const decodeMailboxes = Schema.decodeUnknownSync(SalesMailboxList);

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
    expect(mailboxFacts(mailbox, list.bounceRule, now)).toMatch(
      /^0 of 0 cold today · Resting until /,
    );
    const rested = { ...mailbox, restUntil: "2026-11-09T18:00:00.000Z" };
    expect(mailboxState(rested, list.bounceRule, now)).toMatchObject({
      restingUntil: null,
      nextSendAt: "2026-11-09T18:35:00.000Z",
    });
  });

  it("counts hard bounces against the rule that benches a mailbox", () => {
    expect(mailboxFacts(byAddress("c@x.example"), list.bounceRule, now)).toBe(
      "0 of 0 cold today · 2 of 3 hard bounces before it is benched",
    );
  });

  it("sums the pool by status in the order mailboxes move through", () => {
    expect(poolLine(list.items)).toBe("2 active, 1 benched, 1 retired");
    expect(poolLine([])).toBe("No mailboxes");
  });

  it("names the statuses it knows, and shows one it does not as the engine's word", () => {
    expect([mailboxStatusLabel("warming"), mailboxStatusTone("warming")]).toEqual([
      "Warming up",
      "info",
    ]);
    expect([mailboxStatusLabel("active"), mailboxStatusTone("active")]).toEqual(["Active", null]);
    expect([mailboxStatusLabel("quarantined"), mailboxStatusTone("quarantined")]).toEqual([
      "quarantined",
      "outline",
    ]);
  });
});

describe("healthLines", () => {
  it("reads the escaped message as plain lines, without its bullets", () => {
    expect(
      healthLines(
        "Engine needs a look: 3 sent. In the last 24 hours:\n- First: Q&amp;A &lt;draft&gt;\n\n",
      ),
    ).toEqual(["Engine needs a look: 3 sent. In the last 24 hours:", "First: Q&A <draft>"]);
  });

  it("shows a Slack link as its label, and a mention as a name", () => {
    expect(
      healthLines(
        "See <https://status.example.com|the status page> or <https://x.example>, <@U123> <#C9|outreach> <!here>",
      ),
    ).toEqual(["See the status page or https://x.example, @U123 #outreach @here"]);
  });

  it("never reads escaped text as a link", () => {
    expect(healthLines("&lt;https://evil.example|click&gt;")).toEqual([
      "<https://evil.example|click>",
    ]);
  });
});
