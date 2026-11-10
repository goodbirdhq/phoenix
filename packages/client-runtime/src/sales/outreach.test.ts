import type { SalesQueueItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approveRequestFailure, listedVersionMoved, tickedForReview } from "./outreach.ts";

const item = (activityId: string, contentHash: string, state = "awaiting"): SalesQueueItem => ({
  activityId,
  kind: "first",
  step: 1,
  stepLabel: "Email 1",
  contact: {
    id: "",
    name: null,
    email: null,
    accountName: null,
    timeZone: null,
    effectiveTimeZone: null,
    notionUrl: null,
    linkedinUrl: null,
  },
  campaign: null,
  subject: "Hello",
  threaded: false,
  bodyPreview: "Hi",
  contentHash,
  state,
  approval: null,
  sendAt: null,
  goes: null,
  mailbox: { sticky: false, address: null, threadState: null },
  refusal: null,
  note: null,
  check: null,
  skip: null,
  sendStatus: null,
  notionUrl: null,
  rowEditedAt: null,
});

describe("tickedForReview", () => {
  it("keeps a tick only while the row is listed with the hash captured at the tick", () => {
    const order = [
      item("a", "AAA"),
      item("b", "bbb-new"),
      item("c", "ccc", "approved"),
      item("d", "ddd"),
    ];
    const ticked = new Map([
      ["a", "aaa"],
      // The next poll swapped this row's content after the tick.
      ["b", "bbb-old"],
      ["c", "ccc"],
    ]);
    expect(tickedForReview(order, ticked).map((row) => row.activityId)).toEqual(["a"]);
  });
});

describe("listedVersionMoved", () => {
  it("reads again once per change in the listed hash", () => {
    expect(listedVersionMoved("h1", "h2", "h1")).toBe(true);
    // The read came back still disagreeing with the list: no second read until the list moves.
    expect(listedVersionMoved("h2", "h2", "h3")).toBe(false);
    // The list caught up with what is shown.
    expect(listedVersionMoved("h1", "H2", "h2")).toBe(false);
    expect(listedVersionMoved("h1", null, "h1")).toBe(false);
    expect(listedVersionMoved("h1", "h2", null)).toBe(false);
  });
});

describe("approveRequestFailure", () => {
  it("says nothing was approved only when the engine refused before approving", () => {
    expect(approveRequestFailure("unauthorised", "The engine refused the token.")).toEqual({
      unknown: false,
      text: "The engine refused the token.",
    });
    for (const reason of ["unreachable", "failed", "other", null] as const) {
      expect(approveRequestFailure(reason, "Timed out.").unknown).toBe(true);
    }
  });
});
