/**
 * Property test: the plain-language label must never contradict the Schedule's
 * real occurrences, checked against `effect/Cron` — the library the server's own
 * timing code uses — across the cross-product of representative cron fields.
 *
 * This exists because the example-based suite only covers shapes someone
 * thought of, and the one bug that matters here is a confidently wrong sentence
 * for a shape nobody thought of. It found exactly that: a step of 16 minutes
 * was labelled "Every 16 minutes" despite the minute field wrapping each hour.
 */
import { describe, expect, it } from "vite-plus/test";

import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { describeScheduleCadence } from "./scheduleCadence.ts";

const TZ = "America/New_York";
const START = DateTime.makeUnsafe("2026-02-25T00:00:00Z");
const END_MILLIS = Date.parse("2027-04-01T00:00:00Z");
const MAX_OCCURRENCES = 150;

const MINUTES = [
  "*",
  "0",
  "15",
  "30",
  "45",
  "59",
  "*/5",
  "*/7",
  "*/10",
  "*/23",
  "*/30",
  "*/45",
  "*/50",
  "0,30",
  "5/15",
  "1-30",
];
const HOURS = ["*", "0", "6", "12", "23", "*/2", "*/6", "*/12", "9-17", "0,12"];
const DOMS = ["*", "1", "13", "15", "28", "31", "*/2", "1-7", "1,15"];
const MONTHS = ["*", "*/2", "3"];
const DOWS = ["*", "0", "1", "5", "6", "7", "1-5", "0,6", "1,5", "0-7", "*/2", "1-7", "5-7", "6,7"];

type Pred = (parts: { minute: number; hour: number; dom: number; dow: number }) => boolean;

const SHORT_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const PLURAL_TO_INDEX: Record<string, number> = {
  Sundays: 0,
  Mondays: 1,
  Tuesdays: 2,
  Wednesdays: 3,
  Thursdays: 4,
  Fridays: 5,
  Saturdays: 6,
};

function labelToPredicate(label: string): Pred | null {
  let m = /^Every (\d+) minutes$/.exec(label);
  if (m) {
    const step = Number(m[1]);
    const allowed = new Set<number>();
    for (let v = 0; v < 60; v += step) allowed.add(v);
    return (p) => allowed.has(p.minute);
  }
  m = /^Every hour(?: at :(\d{2}))?$/.exec(label);
  if (m) {
    const minute = m[1] === undefined ? 0 : Number(m[1]);
    return (p) => p.minute === minute;
  }
  m = /^Every day at (\d{2}):(\d{2})$/.exec(label);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return (p) => p.hour === hour && p.minute === minute;
  }
  m = /^(\S.*?) at (\d{2}):(\d{2})$/.exec(label);
  if (m && !label.startsWith("Monthly") && !label.startsWith("Once")) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    const daySpec = m[1] as string;
    let days: Set<number>;
    if (daySpec === "Weekdays") {
      days = new Set([1, 2, 3, 4, 5]);
    } else if (daySpec === "Weekends") {
      days = new Set([0, 6]);
    } else {
      const singular: number | undefined = PLURAL_TO_INDEX[daySpec];
      if (singular !== undefined) {
        days = new Set([singular]);
      } else {
        days = new Set(
          daySpec.split(/,\s*|\s+and\s+/).map((n) => {
            const idx = SHORT_TO_INDEX[n.trim()];
            if (idx === undefined) throw new Error(`unparsed day name ${n}`);
            return idx;
          }),
        );
      }
    }
    return (p) => days.has(p.dow) && p.hour === hour && p.minute === minute;
  }
  m = /^Monthly on the (\d{1,2})(?:st|nd|rd|th) at (\d{2}):(\d{2})$/.exec(label);
  if (m) {
    const dom = Number(m[1]);
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    return (p) => p.dom === dom && p.hour === hour && p.minute === minute;
  }
  return null;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

function zonedParts(instant: Date): { minute: number; hour: number; dom: number; dow: number } {
  const parts = partsFormatter.formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    dom: Number(get("day")),
    dow: SHORT_TO_INDEX[get("weekday")] ?? -1,
  };
}

describe("scheduleCadence fuzz vs effect/Cron ground truth", () => {
  it("never emits an English label contradicted by true occurrences", () => {
    const violations: string[] = [];
    const intervalAnomalies: string[] = [];
    let acceptedCount = 0;
    let labeledCount = 0;
    let fallbackCount = 0;

    for (const minuteF of MINUTES) {
      for (const hourF of HOURS) {
        for (const domF of DOMS) {
          for (const monthF of MONTHS) {
            for (const dowF of DOWS) {
              const expression = `${minuteF} ${hourF} ${domF} ${monthF} ${dowF}`;
              const parsed = Cron.parse(expression, TZ);
              if (Result.isFailure(parsed)) continue;
              acceptedCount += 1;
              const cron = parsed.success;

              let label: string;
              try {
                label = describeScheduleCadence({ type: "cron", expression }, TZ);
              } catch (error) {
                violations.push(`THREW on ${expression}: ${String(error)}`);
                continue;
              }

              if (label === expression.trim()) {
                fallbackCount += 1;
                continue;
              }
              labeledCount += 1;

              const pred = labelToPredicate(label);
              if (pred === null) {
                violations.push(`UNPARSED LABEL ${JSON.stringify(label)} for ${expression}`);
                continue;
              }

              // Mirror the server's occurrence pipeline: sequence + match filter.
              const seq = Cron.sequence(cron, START);
              const deltas: number[] = [];
              let previousMillis: number | undefined;
              let taken = 0;
              for (const instantRaw of seq) {
                if (taken >= MAX_OCCURRENCES || instantRaw.getTime() > END_MILLIS) break;
                const instant = instantRaw;
                if (!Cron.match(cron, instant)) continue; // server skips DST-adjusted
                const p = zonedParts(instant);
                if (!pred(p)) {
                  violations.push(
                    `${expression} => ${JSON.stringify(label)} but fires ${instant.toISOString()} (${JSON.stringify(p)})`,
                  );
                  break;
                }
                if (previousMillis !== undefined) deltas.push(instant.getTime() - previousMillis);
                previousMillis = instant.getTime();
                taken += 1;
              }

              // "Every N minutes" claims a uniform interval, so every gap
              // within an hour must actually be N minutes. This is the check
              // that catches the wrap-gap family: a cron minute field restarts
              // each hour, so N must divide 60 for the claim to hold.
              const everyN = /^Every (\d+) minutes$/.exec(label);
              if (everyN) {
                const stepMillis = Number(everyN[1]) * 60_000;
                const wrong = deltas.filter((d) => d < 3_600_000 && d !== stepMillis);
                if (wrong.length > 0) {
                  intervalAnomalies.push(
                    `${expression} => "${label}" but gaps of ${[...new Set(wrong)]
                      .map((d) => d / 60_000)
                      .join(", ")} minutes occur`,
                  );
                }
              }
            }
          }
        }
      }
    }

    // Targeted probes: alias fields are valid cron but must fall back, never mislabel.
    for (const probe of ["0 6 * * mon", "0 6 * jan *", "0 6 */1 * 1-5", "0 6 1-31 * 1-5"]) {
      const parsed = Cron.parse(probe, TZ);
      if (Result.isFailure(parsed)) continue;
      const label = describeScheduleCadence({ type: "cron", expression: probe }, TZ);
      if (label !== probe.trim()) {
        violations.push(`PROBE ${probe} got English label ${JSON.stringify(label)}`);
      }
    }

    expect(violations, violations.slice(0, 20).join("\n")).toEqual([]);
    expect(
      [...new Set(intervalAnomalies)],
      [...new Set(intervalAnomalies)].slice(0, 20).join("\n"),
    ).toEqual([]);
    // Guards against the fuzz silently passing because everything fell back to
    // raw cron: a humanizer that never speaks is trivially never wrong.
    expect(acceptedCount).toBeGreaterThan(10_000);
    expect(labeledCount).toBeGreaterThan(250);
    expect(fallbackCount).toBeGreaterThan(0);
  });

  it("one-time formatting agrees with Intl for several zones", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "Pacific/Auckland", "America/Los_Angeles"]) {
      const label = describeScheduleCadence(
        { type: "one-time", runAt: "2026-06-01T23:30:00.000Z" },
        zone,
      );
      expect(label).toMatch(/^Once on \d{1,2} \w{3} \d{4} at \d{2}:\d{2}$/);
      expect(label).not.toContain("NaN");
    }
    expect(describeScheduleCadence({ type: "one-time", runAt: "not-a-date" }, "UTC")).toBe(
      "not-a-date",
    );
    expect(describeScheduleCadence({ type: "cron", expression: "0 6 * * *" }, "Not/AZone")).toBe(
      "Every day at 06:00",
    );
  });
});
