import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ScheduleTiming } from "@t3tools/contracts";

const MINIMUM_RECURRENCE_MS = 5 * 60 * 1_000;
const PREVIEW_COUNT = 3;
const VALIDATION_OCCURRENCE_COUNT = 512;
const MAX_EXACT_SKIPPED_OCCURRENCE_COUNT = 10_000;

const ScheduleTimeZone = Schema.String.check(
  Schema.makeFilter(
    (timeZone) =>
      Option.isSome(DateTime.zoneFromString(timeZone)) || `Invalid IANA time zone: ${timeZone}`,
  ),
);
const FiveFieldCronExpression = Schema.String.check(
  Schema.makeFilter(
    (expression) =>
      expression.trim().split(/\s+/).length === 5 ||
      "Recurring Schedules require a standard five-field cron expression.",
  ),
);
const ScheduleInstant = Schema.String.check(
  Schema.makeFilter((value) => Option.isSome(DateTime.make(value)) || "Invalid Schedule instant."),
);
const decodeTimeZone = Schema.decodeUnknownSync(ScheduleTimeZone);
const decodeCronExpression = Schema.decodeUnknownSync(FiveFieldCronExpression);
const decodeScheduleInstant = Schema.decodeUnknownSync(ScheduleInstant);

function assertTimeZone(timeZone: string): void {
  decodeTimeZone(timeZone);
}

function parseCron(expression: string, timeZone: string): Cron.Cron {
  const parsed = Cron.parse(decodeCronExpression(expression), timeZone);
  if (Result.isFailure(parsed)) {
    throw new Error(parsed.failure.message);
  }
  return parsed.success;
}

function wallClockKey(instant: Date, timeZone: string): string {
  const parts = DateTime.makeZonedUnsafe(instant, { timeZone }).pipe(DateTime.toParts);
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}`;
}

function* validCronOccurrences(
  cron: Cron.Cron,
  timeZone: string,
  after: DateTime.DateTime.Input,
): IterableIterator<Date> {
  let previousWallClock: string | undefined;
  for (const occurrence of Cron.sequence(cron, after)) {
    // Cron's DST adjustment maps a nonexistent wall time onto a real instant.
    // A Schedule instead skips that wall time, so verify the adjusted instant
    // still matches the saved calendar rule.
    if (!Cron.match(cron, occurrence)) continue;
    const wallClock = wallClockKey(occurrence, timeZone);
    // Both instants in a fall-back fold have the same wall-clock identity.
    if (wallClock === previousWallClock) continue;
    previousWallClock = wallClock;
    yield occurrence;
  }
}

function previousValidCronOccurrence(cron: Cron.Cron, throughInclusive: DateTime.DateTime): Date {
  let cursor = throughInclusive.pipe(DateTime.addDuration("1 millis"));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const candidate = Cron.prev(cron, cursor);
      if (Cron.match(cron, candidate)) return candidate;
      cursor = DateTime.makeUnsafe(candidate).pipe(DateTime.subtractDuration("1 millis"));
    } catch {
      // Effect Cron can reject a nonexistent DST wall time instead of
      // stepping past it. Move behind that local day and retry; ordinary
      // sparse expressions still resolve in the first attempt.
      cursor = cursor.pipe(DateTime.subtractDuration("1 day"));
    }
  }
  throw new Error("The cron expression has no valid prior Occurrence near the comparison time.");
}

export function previewScheduleTiming(
  timing: ScheduleTiming,
  timeZone: string,
  after: string,
  options?: { readonly allowPastOneTime?: boolean; readonly previewCount?: number },
): ReadonlyArray<string> {
  assertTimeZone(timeZone);
  const afterDate = DateTime.makeUnsafe(decodeScheduleInstant(after));

  if (timing.type === "one-time") {
    const runAt = DateTime.makeUnsafe(decodeScheduleInstant(timing.runAt));
    if (
      !options?.allowPastOneTime &&
      DateTime.toEpochMillis(runAt) <= DateTime.toEpochMillis(afterDate)
    ) {
      throw new Error("A one-time Schedule must use a future time.");
    }
    return [DateTime.formatIso(runAt)];
  }

  const cron = parseCron(timing.expression, timeZone);
  const sequence = validCronOccurrences(cron, timeZone, afterDate);
  const previewCount = Math.min(
    Math.max(options?.previewCount ?? PREVIEW_COUNT, 1),
    VALIDATION_OCCURRENCE_COUNT,
  );
  const preview: Array<string> = [];
  let previousMillis = DateTime.toEpochMillis(afterDate);
  for (let index = 0; index < VALIDATION_OCCURRENCE_COUNT; index += 1) {
    const next = sequence.next().value;
    if (!(next instanceof Date)) {
      throw new Error("The cron expression has no future Occurrence.");
    }
    if (next.getTime() - previousMillis < MINIMUM_RECURRENCE_MS && index > 0) {
      throw new Error("Recurring Schedules must be at least five minutes apart.");
    }
    if (preview.length < previewCount) preview.push(next.toISOString());
    previousMillis = next.getTime();
  }
  return preview;
}

export function nextScheduleOccurrence(
  timing: ScheduleTiming,
  timeZone: string,
  after: string,
): string {
  return previewScheduleTiming(timing, timeZone, after)[0] as string;
}

export function latestScheduleOccurrenceAtOrBefore(
  timing: ScheduleTiming,
  timeZone: string,
  firstDueAt: string,
  throughInclusive: string,
): {
  readonly scheduledFor: string;
  readonly nextOccurrenceAt: string | null;
  readonly skipped: null | {
    readonly count: number;
    readonly countIsLowerBound: boolean;
    readonly firstScheduledFor: string;
    readonly lastScheduledFor: string;
  };
} {
  if (timing.type === "one-time") {
    return { scheduledFor: timing.runAt, nextOccurrenceAt: null, skipped: null };
  }
  assertTimeZone(timeZone);
  const cron = parseCron(timing.expression, timeZone);
  const through = DateTime.makeUnsafe(throughInclusive);
  const latestCandidate = previousValidCronOccurrence(cron, through);
  const firstDue = DateTime.makeUnsafe(firstDueAt);
  const scheduledFor =
    latestCandidate.getTime() < DateTime.toEpochMillis(firstDue)
      ? firstDueAt
      : latestCandidate.toISOString();
  const next = validCronOccurrences(cron, timeZone, DateTime.makeUnsafe(scheduledFor)).next().value;
  let skipped: {
    readonly count: number;
    readonly countIsLowerBound: boolean;
    readonly firstScheduledFor: string;
    readonly lastScheduledFor: string;
  } | null = null;
  if (scheduledFor !== firstDueAt) {
    let count = 0;
    let countIsLowerBound = false;
    const start = DateTime.makeUnsafe(firstDueAt).pipe(DateTime.subtractDuration("1 millis"));
    for (const occurrence of validCronOccurrences(cron, timeZone, start)) {
      if (occurrence.toISOString() >= scheduledFor) break;
      count += 1;
      if (count === MAX_EXACT_SKIPPED_OCCURRENCE_COUNT) {
        countIsLowerBound = true;
        break;
      }
    }
    const lastSkipped = previousValidCronOccurrence(
      cron,
      DateTime.makeUnsafe(scheduledFor).pipe(DateTime.subtractDuration("1 millis")),
    );
    skipped = {
      count,
      countIsLowerBound,
      firstScheduledFor: firstDueAt,
      lastScheduledFor: lastSkipped.toISOString(),
    };
  }
  return {
    scheduledFor,
    nextOccurrenceAt: next instanceof Date ? next.toISOString() : null,
    skipped,
  };
}
