import { describe, expect, it } from "vite-plus/test";

import { latestScheduleOccurrenceAtOrBefore, previewScheduleTiming } from "./timing.ts";

describe("Schedule timing", () => {
  it("accepts the five-minute cron boundary and rejects a four-minute rule", () => {
    expect(
      previewScheduleTiming(
        { type: "cron", expression: "*/5 * * * *" },
        "UTC",
        "2026-08-19T10:02:00.000Z",
      ).slice(0, 2),
    ).toEqual(["2026-08-19T10:05:00.000Z", "2026-08-19T10:10:00.000Z"]);

    expect(() =>
      previewScheduleTiming(
        { type: "cron", expression: "*/4 * * * *" },
        "UTC",
        "2026-08-19T10:02:00.000Z",
      ),
    ).toThrow(/five minutes/i);
  });

  it("skips nonexistent DST wall time and emits repeated wall time once", () => {
    expect(
      previewScheduleTiming(
        { type: "cron", expression: "30 2 * * *" },
        "Europe/Berlin",
        "2026-03-28T02:00:00.000Z",
      ).slice(0, 2),
    ).toEqual(["2026-03-30T00:30:00.000Z", "2026-03-31T00:30:00.000Z"]);

    const fallback = previewScheduleTiming(
      { type: "cron", expression: "30 2 * * *" },
      "Europe/Berlin",
      "2026-10-24T02:00:00.000Z",
    );
    expect(fallback.filter((instant) => instant.startsWith("2026-10-25")).length).toBe(1);
  });

  it("does not retain a nonexistent DST tick during offline catch-up", () => {
    expect(
      latestScheduleOccurrenceAtOrBefore(
        { type: "cron", expression: "30 2 * * *" },
        "Europe/Berlin",
        "2026-03-28T01:30:00.000Z",
        "2026-03-29T22:00:00.000Z",
      ),
    ).toMatchObject({
      scheduledFor: "2026-03-28T01:30:00.000Z",
      nextOccurrenceAt: "2026-03-30T00:30:00.000Z",
      skipped: null,
    });
  });

  it("does not retain the duplicate side of a repeated DST wall time", () => {
    expect(
      latestScheduleOccurrenceAtOrBefore(
        { type: "cron", expression: "30 2 * * *" },
        "Europe/Berlin",
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T03:00:00.000Z",
      ),
    ).toMatchObject({
      scheduledFor: "2026-10-25T00:30:00.000Z",
      nextOccurrenceAt: "2026-10-26T01:30:00.000Z",
      skipped: null,
    });
  });

  it("rejects a past one-time value and an invalid IANA zone", () => {
    expect(() =>
      previewScheduleTiming(
        { type: "one-time", runAt: "2026-08-19T10:00:00.000Z" },
        "UTC",
        "2026-08-19T10:02:00.000Z",
      ),
    ).toThrow(/future/i);
    expect(() =>
      previewScheduleTiming(
        { type: "one-time", runAt: "2026-08-20T10:00:00.000Z" },
        "Mars/Olympus",
        "2026-08-19T10:02:00.000Z",
      ),
    ).toThrow(/time zone/i);
  });
});
