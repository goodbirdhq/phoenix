import * as Cron from "effect/Cron";
import type * as DateTime from "effect/DateTime";
import * as DateTimeRuntime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { ScheduleTiming } from "@t3tools/contracts";

export interface CronTimingInspection {
  readonly valid: boolean;
  readonly error: string | null;
  readonly highFrequency: boolean;
  readonly occurrences: ReadonlyArray<string>;
}

export interface ZonedWallTimeResult {
  readonly valid: boolean;
  readonly instant: string | null;
  readonly error: string | null;
}

export type CronBuilderRule =
  | { readonly cadence: "minutes"; readonly interval: number }
  | { readonly cadence: "hourly"; readonly minute: number }
  | { readonly cadence: "daily"; readonly hour: number; readonly minute: number }
  | {
      readonly cadence: "weekly";
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    };

const INVALID_FIVE_FIELD_CRON = "Use a standard five-field cron expression.";
const INVALID_TIME_ZONE = "Choose a valid IANA time zone.";
const TOO_FREQUENT = "Schedules cannot run more often than every 5 minutes.";

function fieldValues(values: ReadonlySet<number>, maximum: number): ReadonlyArray<number> {
  return values.size === 0 ? Array.from({ length: maximum }, (_, index) => index) : [...values];
}

/** The shortest possible gap for any two allowed wall-clock times in a day. */
function shortestDailyGapMinutes(cron: Cron.Cron): number {
  const minutes = fieldValues(cron.minutes, 60);
  const hours = fieldValues(cron.hours, 24);
  const times = hours
    .flatMap((hour) => minutes.map((minute) => hour * 60 + minute))
    .toSorted((left, right) => left - right);
  if (times.length === 0) return Number.POSITIVE_INFINITY;
  if (times.length === 1) return 24 * 60;

  let shortest = 24 * 60;
  for (let index = 1; index < times.length; index += 1) {
    shortest = Math.min(shortest, times[index]! - times[index - 1]!);
  }
  shortest = Math.min(shortest, times[0]! + 24 * 60 - times[times.length - 1]!);
  return shortest;
}

function invalid(error: string): CronTimingInspection {
  return { valid: false, error, highFrequency: false, occurrences: [] };
}

export function inspectCronTiming(input: {
  readonly expression: string;
  readonly timeZone: string;
  readonly after: DateTime.DateTime.Input;
}): CronTimingInspection {
  const fields = input.expression.trim().split(/\s+/u);
  if (fields.length !== 5) return invalid(INVALID_FIVE_FIELD_CRON);

  try {
    Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    return invalid(INVALID_TIME_ZONE);
  }

  const parsed = Cron.parse(input.expression.trim(), input.timeZone);
  if (Result.isFailure(parsed)) return invalid(INVALID_FIVE_FIELD_CRON);
  const shortestGap = shortestDailyGapMinutes(parsed.success);
  if (shortestGap < 5) return invalid(TOO_FREQUENT);

  const sequence = Cron.sequence(parsed.success, input.after);
  const occurrences: string[] = [];
  // Some clocks normalize a nonexistent wall time to the first valid instant
  // after a DST jump. It is not an Occurrence unless it still matches the
  // saved wall-clock rule.
  while (occurrences.length < 3) {
    const candidate = sequence.next().value;
    if (Cron.match(parsed.success, candidate)) {
      occurrences.push(candidate.toISOString());
    }
  }
  return {
    valid: true,
    error: null,
    highFrequency: shortestGap === 5,
    occurrences,
  };
}

function validClockField(value: number, maximum: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Invalid ${field}.`);
  }
}

export function cronBuilderExpression(rule: CronBuilderRule): string {
  switch (rule.cadence) {
    case "minutes":
      if (!Number.isInteger(rule.interval) || rule.interval < 5 || rule.interval > 59) {
        throw new RangeError("Minute interval must be between 5 and 59.");
      }
      return `*/${rule.interval} * * * *`;
    case "hourly":
      validClockField(rule.minute, 59, "minute");
      return `${rule.minute} * * * *`;
    case "daily":
      validClockField(rule.minute, 59, "minute");
      validClockField(rule.hour, 23, "hour");
      return `${rule.minute} ${rule.hour} * * *`;
    case "weekly":
      validClockField(rule.minute, 59, "minute");
      validClockField(rule.hour, 23, "hour");
      validClockField(rule.weekday, 6, "weekday");
      return `${rule.minute} ${rule.hour} * * ${rule.weekday}`;
  }
}

export function zonedWallTimeToInstant(wallTime: string, timeZone: string): ZonedWallTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(wallTime);
  if (!match) return { valid: false, instant: null, error: "Choose a valid date and time." };
  const requested = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const zoned = DateTimeRuntime.makeZoned(requested, {
    timeZone,
    adjustForTimeZone: true,
    disambiguation: "compatible",
  });
  if (Option.isNone(zoned)) {
    return { valid: false, instant: null, error: "Choose a valid date, time, and IANA zone." };
  }
  const actual = DateTimeRuntime.toParts(zoned.value);
  if (
    actual.year !== requested.year ||
    actual.month !== requested.month ||
    actual.day !== requested.day ||
    actual.hour !== requested.hour ||
    actual.minute !== requested.minute
  ) {
    return {
      valid: false,
      instant: null,
      error: `That local time does not exist in ${timeZone}.`,
    };
  }
  return {
    valid: true,
    instant: DateTimeRuntime.formatIso(zoned.value),
    error: null,
  };
}

export function currentScheduleTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function scheduleTimeZoneIsValid(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function scheduleWallTimeInputForInstant(instant: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(DateTimeRuntime.toDate(DateTimeRuntime.makeUnsafe(instant)));
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const input = `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(input) ? input : null;
  } catch {
    return null;
  }
}

export function defaultScheduleOneTimeInput(
  currentInstant: DateTime.DateTime.Input,
  timeZone = currentScheduleTimeZone(),
): string {
  const runAt = DateTimeRuntime.makeUnsafe(currentInstant).pipe(
    DateTimeRuntime.addDuration("1 hour"),
    DateTimeRuntime.formatIso,
  );
  const input = scheduleWallTimeInputForInstant(runAt, timeZone);
  if (input === null) throw new RangeError(`Could not format a Schedule time in ${timeZone}.`);
  return input;
}

export function formatScheduleTimestamp(value: string | null, timeZone?: string): string {
  if (value === null) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(DateTimeRuntime.toDate(DateTimeRuntime.makeUnsafe(value)));
  } catch {
    return value;
  }
}

export function formatScheduleTiming(timing: ScheduleTiming, timeZone: string): string {
  return timing.type === "cron"
    ? `${timing.expression} · ${timeZone}`
    : `Once · ${formatScheduleTimestamp(timing.runAt, timeZone)} · ${timeZone}`;
}
