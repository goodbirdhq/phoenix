/** How a moment reads to the person, and to the contact when their clock shows another time. */
export interface SalesTime {
  /** In the viewer's zone: `9:23 AM`, or `Tue 9:23 AM` on another day than today. */
  readonly local: string;
  /** On the contact's clock, `14:23 their time`; null when it reads the same as `local`. */
  readonly theirs: string | null;
}

export interface SalesTimeOptions {
  /** The contact's IANA zone. */
  readonly theirZone?: string | null;
  /** The viewer's zone and locale; the runtime's when unset. */
  readonly localZone?: string;
  readonly locale?: string;
}

const formatter = (locale: string | undefined, timeZone: string | undefined, weekday: boolean) =>
  new Intl.DateTimeFormat(locale, {
    timeZone,
    ...(weekday ? { weekday: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });

const dayKey = (ms: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(ms);

const isZone = (zone: string) => {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** A sales instant for display, with `now` deciding what "today" is. Null for a missing or unreadable one. */
export function salesTime(
  iso: string | null,
  now: number,
  options: SalesTimeOptions = {},
): SalesTime | null {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const { locale, localZone } = options;
  const local = formatter(locale, localZone, dayKey(ms, localZone) !== dayKey(now, localZone));
  const theirZone = options.theirZone;
  if (!theirZone || !isZone(theirZone)) return { local: local.format(ms), theirs: null };
  const otherDay = dayKey(ms, theirZone) !== dayKey(ms, localZone);
  const theirs = formatter(locale, theirZone, otherDay).format(ms);
  const sameClock = theirs === formatter(locale, localZone, otherDay).format(ms);
  return { local: local.format(ms), theirs: sameClock ? null : `${theirs} their time` };
}

/** A `YYYY-MM-DD` day as `Thu 12 Nov`, read as a calendar day with no zone. */
export function salesDay(day: string, locale?: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Number.isNaN(ms)
    ? day
    : new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(ms);
}
