import { type SalesQueueItem, ThreadId, salesDispatchThreadPrefix } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dispatchedThreads,
  listedVersionMoved,
  queueSummary,
  tickedForReview,
} from "./outreach.ts";

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

describe("dispatchedThreads", () => {
  const titles = new Map([
    [ThreadId.make("sales:card:act-1:t1"), "Redraft for Ana"],
    [ThreadId.make("sales:card:act-10:t2"), "Redraft for Bo"],
    [ThreadId.make("sales:contact:act-1:t3"), "Draft an answer to Ana"],
    [ThreadId.make("thread-4"), "Unrelated"],
  ]);

  it("finds only the threads started from that card or conversation", () => {
    expect(dispatchedThreads(titles, [salesDispatchThreadPrefix({ activityId: "act-1" })])).toEqual(
      [{ threadId: "sales:card:act-1:t1", title: "Redraft for Ana" }],
    );
    expect(dispatchedThreads(titles, [salesDispatchThreadPrefix({ contactKey: "act-1" })])).toEqual(
      [{ threadId: "sales:contact:act-1:t3", title: "Draft an answer to Ana" }],
    );
  });

  it("joins the runs of a reply card and its conversation", () => {
    expect(
      dispatchedThreads(titles, [
        salesDispatchThreadPrefix({ activityId: "act-1" }),
        salesDispatchThreadPrefix({ contactKey: "act-1" }),
      ]).map((run) => run.title),
    ).toEqual(["Redraft for Ana", "Draft an answer to Ana"]);
  });
});

describe("queueSummary", () => {
  it("says what the open cards wait on, review first", () => {
    expect(
      queueSummary([
        { state: "approved", sendAt: "2026-11-10T09:00:00.000Z" },
        { state: "awaiting", sendAt: null },
        { state: "approved", sendAt: "2026-11-10T10:00:00.000Z" },
        { state: "awaiting", sendAt: null },
      ]),
    ).toBe("2 to review · 2 scheduled");
  });

  it("names held, refused and unknown states, and an approval with no send time", () => {
    expect(
      queueSummary([
        { state: "mystery", sendAt: null },
        { state: "approved", sendAt: null },
        { state: "held", sendAt: null },
        { state: "refused", sendAt: null },
      ]),
    ).toBe("1 refused · 1 held · 1 approved · 1 mystery");
  });

  it("reads an empty list as nothing waiting", () => {
    expect(queueSummary([])).toBe("Nothing waits");
  });
});
