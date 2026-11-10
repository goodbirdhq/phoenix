import { SalesSummary, type SalesSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applySalesRead } from "./sales.ts";

const summary = Schema.decodeUnknownSync(SalesSummary)({
  generatedAt: "2026-11-10T09:00:00.000Z",
  dispatcher: {
    lastPokeAt: "2026-11-10T08:58:00.000Z",
    pokeAgeSeconds: 120,
    tickAgeSeconds: null,
    nextTickAt: "2026-11-10T09:05:00.000Z",
  },
});

const snapshot: SalesSnapshot = {
  status: "ready",
  message: null,
  summary,
  queue: null,
  summaryReadAt: "2026-11-10T09:00:01.000Z",
  checkedAt: "2026-11-10T09:00:01.000Z",
  dispatches: [],
};

describe("applySalesRead", () => {
  it("moves the read times and what the engine measured at the read, and nothing else", () => {
    const next = applySalesRead(snapshot, {
      type: "sales-read",
      summaryReadAt: "2026-11-10T09:01:01.000Z",
      checkedAt: "2026-11-10T09:01:01.000Z",
    });
    expect(next.summaryReadAt).toBe("2026-11-10T09:01:01.000Z");
    expect(next.checkedAt).toBe("2026-11-10T09:01:01.000Z");
    // A dispatcher that stopped keeps ageing between reads that found nothing else new.
    expect(next.summary?.dispatcher.pokeAgeSeconds).toBe(180);
    expect(next.summary?.dispatcher.tickAgeSeconds).toBeNull();
    expect(next.summary?.generatedAt).toBe("2026-11-10T09:01:00.000Z");
    expect({ ...next.summary, generatedAt: "", dispatcher: null }).toEqual({
      ...summary,
      generatedAt: "",
      dispatcher: null,
    });
  });

  it("ages nothing when only a failed read's check time moved", () => {
    const next = applySalesRead(snapshot, {
      type: "sales-read",
      summaryReadAt: snapshot.summaryReadAt,
      checkedAt: "2026-11-10T09:01:01.000Z",
    });
    expect(next.summary).toEqual(summary);
    expect(next.checkedAt).toBe("2026-11-10T09:01:01.000Z");
  });
});
