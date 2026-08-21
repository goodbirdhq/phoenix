import { describe, expect, it } from "vite-plus/test";

import { describeScheduleCadence } from "./scheduleCadence.ts";

const cron = (expression: string) => ({ type: "cron" as const, expression });

describe("describeScheduleCadence", () => {
  it("names the common daily shapes in plain language", () => {
    expect(describeScheduleCadence(cron("0 6 * * *"), "Europe/London")).toBe("Every day at 06:00");
    expect(describeScheduleCadence(cron("30 14 * * *"), "Europe/London")).toBe(
      "Every day at 14:30",
    );
  });

  it("recognises weekdays and weekends as ranges rather than listing days", () => {
    expect(describeScheduleCadence(cron("0 6 * * 1-5"), "Europe/London")).toBe("Weekdays at 06:00");
    expect(describeScheduleCadence(cron("0 9 * * 0,6"), "Europe/London")).toBe("Weekends at 09:00");
  });

  it("distinguishes a weekday list from a weekday range", () => {
    // The mistake this whole label exists to catch: 1,5 is Mon+Fri, not Mon-Fri.
    expect(describeScheduleCadence(cron("0 6 * * 1,5"), "Europe/London")).toBe(
      "Mon and Fri at 06:00",
    );
    expect(describeScheduleCadence(cron("0 6 * * 1"), "Europe/London")).toBe("Mondays at 06:00");
    expect(describeScheduleCadence(cron("0 6 * * 1-3"), "Europe/London")).toBe(
      "Mon, Tue and Wed at 06:00",
    );
  });

  it("describes hourly and sub-hourly cadences", () => {
    expect(describeScheduleCadence(cron("0 * * * *"), "Europe/London")).toBe("Every hour");
    expect(describeScheduleCadence(cron("15 * * * *"), "Europe/London")).toBe("Every hour at :15");
    expect(describeScheduleCadence(cron("*/15 * * * *"), "Europe/London")).toBe("Every 15 minutes");
  });

  it("describes monthly cadences by day of month", () => {
    expect(describeScheduleCadence(cron("0 6 1 * *"), "Europe/London")).toBe(
      "Monthly on the 1st at 06:00",
    );
    expect(describeScheduleCadence(cron("0 6 22 * *"), "Europe/London")).toBe(
      "Monthly on the 22nd at 06:00",
    );
  });

  it("refuses to claim a uniform interval when the step does not divide 60", () => {
    // The minute field restarts every hour, so */16 fires at :00 :16 :32 :48
    // and then wraps to :00 — a 12-minute gap. "Every 16 minutes" is a
    // confidently wrong sentence, which is worse than showing raw cron, and
    // these all clear the five-minute floor so an agent can really create them.
    expect(describeScheduleCadence(cron("*/16 * * * *"), "Europe/London")).toBe("*/16 * * * *");
    expect(describeScheduleCadence(cron("*/25 * * * *"), "Europe/London")).toBe("*/25 * * * *");
    expect(describeScheduleCadence(cron("*/45 * * * *"), "Europe/London")).toBe("*/45 * * * *");
    expect(describeScheduleCadence(cron("*/55 * * * *"), "Europe/London")).toBe("*/55 * * * *");
  });

  it("still names the steps that do divide 60", () => {
    for (const [step, label] of [
      [5, "Every 5 minutes"],
      [10, "Every 10 minutes"],
      [15, "Every 15 minutes"],
      [20, "Every 20 minutes"],
      [30, "Every 30 minutes"],
    ] as const) {
      expect(describeScheduleCadence(cron(`*/${step} * * * *`), "Europe/London")).toBe(label);
    }
  });

  it("rejects an out-of-range step rather than describing it", () => {
    expect(describeScheduleCadence(cron("*/0 * * * *"), "Europe/London")).toBe("*/0 * * * *");
    expect(describeScheduleCadence(cron("*/61 * * * *"), "Europe/London")).toBe("*/61 * * * *");
  });

  it("falls back to the raw expression when the shape is not a common one", () => {
    // Better an honest cron string than a confident wrong sentence.
    expect(describeScheduleCadence(cron("0 6 1-7 */2 3"), "Europe/London")).toBe("0 6 1-7 */2 3");
  });

  it("formats a one-time schedule as a date in its own zone", () => {
    expect(
      describeScheduleCadence(
        { type: "one-time", runAt: "2026-03-04T06:00:00.000Z" },
        "Europe/London",
      ),
    ).toBe("Once on 4 Mar 2026 at 06:00");
  });

  it("renders a one-time schedule in the schedule's zone, not UTC", () => {
    expect(
      describeScheduleCadence(
        { type: "one-time", runAt: "2026-03-04T06:00:00.000Z" },
        "America/New_York",
      ),
    ).toBe("Once on 4 Mar 2026 at 01:00");
  });
});
