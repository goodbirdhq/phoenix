import { describe, expect, it } from "vite-plus/test";

import {
  cronBuilderExpression,
  defaultScheduleOneTimeInput,
  inspectCronTiming,
  zonedWallTimeToInstant,
} from "./timing.ts";

describe("inspectCronTiming", () => {
  it("validates a five-field expression and previews three zoned occurrences", () => {
    expect(
      inspectCronTiming({
        expression: "0 9 * * 1-5",
        timeZone: "Europe/Berlin",
        after: "2026-08-19T12:00:00.000Z",
      }),
    ).toEqual({
      valid: true,
      error: null,
      highFrequency: false,
      occurrences: [
        "2026-08-20T07:00:00.000Z",
        "2026-08-21T07:00:00.000Z",
        "2026-08-24T07:00:00.000Z",
      ],
    });
  });

  it("accepts the five-minute boundary with the required volume warning", () => {
    expect(
      inspectCronTiming({
        expression: "*/5 * * * *",
        timeZone: "UTC",
        after: "2026-08-19T12:01:00.000Z",
      }),
    ).toEqual({
      valid: true,
      error: null,
      highFrequency: true,
      occurrences: [
        "2026-08-19T12:05:00.000Z",
        "2026-08-19T12:10:00.000Z",
        "2026-08-19T12:15:00.000Z",
      ],
    });
  });

  it("rejects expressions capable of running more often than every five minutes", () => {
    expect(
      inspectCronTiming({
        expression: "*/4 * * * *",
        timeZone: "UTC",
        after: "2026-08-19T12:00:00.000Z",
      }),
    ).toEqual({
      valid: false,
      error: "Schedules cannot run more often than every 5 minutes.",
      highFrequency: false,
      occurrences: [],
    });
  });

  it("rejects seconds fields and invalid IANA zones", () => {
    expect(
      inspectCronTiming({
        expression: "0 */5 * * * *",
        timeZone: "UTC",
        after: "2026-08-19T12:00:00.000Z",
      }).error,
    ).toBe("Use a standard five-field cron expression.");
    expect(
      inspectCronTiming({
        expression: "0 9 * * *",
        timeZone: "Atlantis/Nowhere",
        after: "2026-08-19T12:00:00.000Z",
      }).error,
    ).toBe("Choose a valid IANA time zone.");
  });

  it("skips a nonexistent spring-forward wall time", () => {
    const result = inspectCronTiming({
      expression: "30 2 * * *",
      timeZone: "Europe/Berlin",
      after: "2026-03-28T12:00:00.000Z",
    });

    expect(result.occurrences[0]).toBe("2026-03-30T00:30:00.000Z");
  });
});

describe("cronBuilderExpression", () => {
  it("builds common rules without hiding the saved cron expression", () => {
    expect(cronBuilderExpression({ cadence: "minutes", interval: 15 })).toBe("*/15 * * * *");
    expect(cronBuilderExpression({ cadence: "weekly", hour: 9, minute: 30, weekday: 1 })).toBe(
      "30 9 * * 1",
    );
  });
});

describe("zonedWallTimeToInstant", () => {
  it("converts a wall time using the selected IANA zone instead of the browser zone", () => {
    expect(zonedWallTimeToInstant("2026-08-20T09:30", "Europe/Berlin")).toEqual({
      valid: true,
      instant: "2026-08-20T07:30:00.000Z",
      error: null,
    });
  });

  it("rejects a nonexistent wall time in a daylight-saving gap", () => {
    expect(zonedWallTimeToInstant("2026-03-29T02:30", "Europe/Berlin")).toEqual({
      valid: false,
      instant: null,
      error: "That local time does not exist in Europe/Berlin.",
    });
  });
});

describe("defaultScheduleOneTimeInput", () => {
  it("formats one hour after the supplied instant in the selected local time zone", () => {
    expect(defaultScheduleOneTimeInput("2026-08-20T12:34:56.789Z", "UTC")).toBe("2026-08-20T13:34");
    expect(defaultScheduleOneTimeInput("2026-08-20T12:34:56.789Z", "Europe/Berlin")).toBe(
      "2026-08-20T15:34",
    );
  });

  it("adds an elapsed hour before projecting through a daylight-saving transition", () => {
    expect(defaultScheduleOneTimeInput("2026-03-29T00:30:45.000Z", "Europe/Berlin")).toBe(
      "2026-03-29T03:30",
    );
  });
});
