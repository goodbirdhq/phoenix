import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("requires exact bounds for hourly aggregation", () => {
    expect(
      () =>
        new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          resolution: "hour",
          rates,
        }),
    ).toThrow("requires exact time bounds");
  });

  it("keeps only the first record for a repeated dedupe key", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.duplicatesDropped).toBe(0);
    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("keeps daily payloads collapsed when hourly resolution is not requested", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-08-07T04:05:13.944Z") }),
      record({ timestampMs: Date.parse("2026-08-07T05:05:13.944Z") }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.hourStart).toBeUndefined();
    expect(result.buckets[0]?.records).toBe(2);
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record contributed", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(false);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });

  it("keeps two homes' identical cells apart, and tags each with its source", () => {
    // Two signed-in accounts on one machine: same day, same model, different
    // directory. A client that drops one of those directories as a duplicate
    // has to be able to drop only its records.
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });
    aggregator.add(record({ dedupeKey: "msg_a:" }), "0");
    aggregator.add(record({ dedupeKey: "msg_b:" }), "1");
    const buckets = aggregator.finish().buckets;

    expect(buckets.map((bucket) => bucket.sourceId)).toEqual(["0", "1"]);
    expect(buckets.every((bucket) => bucket.records === 1)).toBe(true);
  });

  it("counts a record copied into both homes once", () => {
    // Claude copies a message forward when a session is resumed, and a
    // resumed session can be handed to the other account's home. De-duplication
    // stays global across sources for exactly that reason.
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }), "0")).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }), "1")).toBe(false);

    const buckets = aggregator.finish().buckets;
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.sourceId).toBe("0");
  });

  it("omits the source when the caller does not name one", () => {
    const result = aggregate([record()]);
    expect(result.buckets[0]?.sourceId).toBeUndefined();
  });
});

describe("session detail", () => {
  const make = () =>
    new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      includeSessions: true,
    });

  it("reconciles model changes and duplicate responses with the overview", () => {
    const aggregator = make();
    aggregator.add(record({ dedupeKey: "first" }), "home");
    aggregator.add(record({ dedupeKey: "first" }), "home");
    aggregator.add(
      record({
        model: "other-model",
        reportedCostUsd: 2,
        timestampMs: Date.parse("2026-08-08T10:00:00Z"),
      }),
      "home",
    );
    const result = aggregator.finish();
    expect(result.sessionUsage).toHaveLength(1);
    const session = result.sessionUsage![0]!;
    expect(session.models).toHaveLength(2);
    expect(session.models.reduce((sum, model) => sum + model.costUsd, 0)).toBe(
      result.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
    );
    expect(session.models.reduce((sum, model) => sum + model.records, 0)).toBe(2);
    expect(session.firstActivityAt).toBe("2026-08-07T04:05:13.944Z");
    expect(session.lastActivityAt).toBe("2026-08-08T10:00:00.000Z");
  });

  it("keeps same ids in different stores and providers separate, and excludes out-of-window usage", () => {
    const aggregator = make();
    aggregator.add(record(), "a");
    aggregator.add(record(), "b");
    aggregator.add(record({ provider: "codex" }), "a");
    aggregator.add(record({ timestampMs: Date.parse("2026-07-01T00:00:00Z") }), "a");
    expect(aggregator.finish().sessionUsage).toHaveLength(3);
    expect(
      aggregator.finish().sessionUsage!.every((session) => session.models[0]?.records === 1),
    ).toBe(true);
  });

  it("keeps anonymous usage in the overview without inventing session identity", () => {
    const aggregator = make();
    aggregator.add(record({ sessionId: "" }), "a");
    aggregator.add(record());
    expect(aggregator.finish().sessionUsage).toEqual([]);
    expect(aggregator.finish().buckets.reduce((sum, bucket) => sum + bucket.records, 0)).toBe(2);
    expect(aggregate([record()]).sessionUsage).toBeUndefined();
  });
});
