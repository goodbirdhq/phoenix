import type { ScheduleTiming } from "@t3tools/contracts";

/**
 * Plain-language label for a Schedule's timing, used wherever a human reads a
 * Schedule outside the editor that built it — the chat card an agent's write
 * leaves behind, and the mobile work-log row.
 *
 * The point is catching the mistakes a raw cron string hides: `1-5` and `1,5`
 * look alike and mean "weekdays" versus "Mondays and Fridays". Shapes that do
 * not reduce to a common sentence fall back to the expression itself rather
 * than guessing, because a confident wrong sentence is worse than cron.
 */
export function describeScheduleCadence(timing: ScheduleTiming, timeZone: string): string {
  if (timing.type === "one-time") {
    const when = formatZonedInstant(timing.runAt, timeZone);
    // An instant we cannot format is returned bare rather than dressed up as
    // "Once on <garbage>": the same fallback rule the cron path follows.
    return when === null ? timing.runAt : `Once on ${when}`;
  }
  return describeCronExpression(timing.expression) ?? timing.expression.trim();
}

type FieldSpec =
  | { readonly kind: "all" }
  | { readonly kind: "step"; readonly step: number }
  | { readonly kind: "values"; readonly values: ReadonlyArray<number> };

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const PLURAL_WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

function parseField(raw: string, min: number, max: number): FieldSpec | null {
  const field = raw.trim();
  if (field === "*") return { kind: "all" };

  const step = /^\*\/(\d+)$/u.exec(field);
  if (step) {
    const value = Number(step[1]);
    return inBounds(value, 1, max) ? { kind: "step", step: value } : null;
  }

  const values = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!inBounds(from, min, max) || !inBounds(to, min, max) || from > to) return null;
      for (let value = from; value <= to; value += 1) values.add(value);
      continue;
    }
    if (!/^\d+$/u.test(part)) return null;
    const value = Number(part);
    if (!inBounds(value, min, max)) return null;
    values.add(value);
  }
  return values.size === 0 ? null : { kind: "values", values: [...values].toSorted(compare) };
}

function inBounds(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function compare(left: number, right: number): number {
  return left - right;
}

function single(spec: FieldSpec | null): number | null {
  return spec?.kind === "values" && spec.values.length === 1 ? (spec.values[0] as number) : null;
}

function describeCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0] as string, 0, 59);
  const hour = parseField(fields[1] as string, 0, 23);
  const dayOfMonth = parseField(fields[2] as string, 1, 31);
  const month = parseField(fields[3] as string, 1, 12);
  const dayOfWeek = parseField(fields[4] as string, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  // Every named shape below is monthly or more frequent, so a restricted month
  // field always means something this vocabulary cannot say.
  if (month.kind !== "all") return null;

  const everyDay = dayOfMonth.kind === "all" && dayOfWeek.kind === "all";

  // A cron minute field restarts every hour, so `*/N` only produces a uniform
  // interval when N divides 60. `*/16` fires at :00 :16 :32 :48 and then wraps
  // to :00 — a 12-minute gap that "Every 16 minutes" flatly contradicts.
  if (minute.kind === "step" && hour.kind === "all" && everyDay && 60 % minute.step === 0) {
    return `Every ${minute.step} minutes`;
  }

  const minuteValue = single(minute);
  if (minuteValue === null) return null;

  if (hour.kind === "all" && everyDay) {
    return minuteValue === 0 ? "Every hour" : `Every hour at :${pad(minuteValue)}`;
  }

  const hourValue = single(hour);
  if (hourValue === null) return null;
  const atTime = `at ${pad(hourValue)}:${pad(minuteValue)}`;

  if (everyDay) return `Every day ${atTime}`;

  if (dayOfMonth.kind === "all" && dayOfWeek.kind === "values") {
    return `${describeWeekdays(dayOfWeek.values)} ${atTime}`;
  }

  const dayOfMonthValue = single(dayOfMonth);
  if (dayOfMonthValue !== null && dayOfWeek.kind === "all") {
    return `Monthly on the ${ordinal(dayOfMonthValue)} ${atTime}`;
  }

  return null;
}

function describeWeekdays(values: ReadonlyArray<number>): string {
  // Cron accepts both 0 and 7 for Sunday.
  const days = [...new Set(values.map((value) => (value === 7 ? 0 : value)))].toSorted(compare);
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (days.length === 1) return PLURAL_WEEKDAYS[days[0] as number] as string;

  const names = days.map((day) => SHORT_WEEKDAYS[day] as string);
  const last = names.pop() as string;
  return `${names.join(", ")} and ${last}`;
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatZonedInstant(instant: string, timeZone: string): string | null {
  const epochMillis = Date.parse(instant);
  if (Number.isNaN(epochMillis)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(epochMillis);
    const find = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${find("day")} ${find("month")} ${find("year")} at ${find("hour")}:${find("minute")}`;
  } catch {
    // An invalid zone is already rejected server-side; a label must not throw.
    return null;
  }
}
