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

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale and options: building one is far dearer than formatting with it. */
const formatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  const key = JSON.stringify([locale ?? null, options]);
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
};

const clock = (locale: string | undefined, timeZone: string | undefined, weekday: boolean) =>
  formatter(locale, {
    timeZone,
    ...(weekday ? { weekday: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });

/** The calendar day an instant falls on in a zone; en-CA writes it as `YYYY-MM-DD`. */
const dayKey = (ms: number, timeZone: string | undefined) =>
  formatter("en-CA", { timeZone }).format(ms);

const knownZones = new Map<string, boolean>();
const isZone = (zone: string) => {
  let known = knownZones.get(zone);
  if (known === undefined) {
    try {
      formatter("en", { timeZone: zone });
      known = true;
    } catch {
      known = false;
    }
    knownZones.set(zone, known);
  }
  return known;
};

const parse = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso));

/** A sales instant for display, with `now` deciding what "today" is. Null for a missing or unreadable one. */
export function salesTime(
  iso: string | null,
  now: number,
  options: SalesTimeOptions = {},
): SalesTime | null {
  const ms = parse(iso);
  if (Number.isNaN(ms)) return null;
  const { locale, localZone } = options;
  const local = clock(locale, localZone, dayKey(ms, localZone) !== dayKey(now, localZone)).format(
    ms,
  );
  const theirZone = options.theirZone;
  if (!theirZone || !isZone(theirZone)) return { local, theirs: null };
  const otherDay = dayKey(ms, theirZone) !== dayKey(ms, localZone);
  const theirs = clock(locale, theirZone, otherDay).format(ms);
  const sameClock = theirs === clock(locale, localZone, otherDay).format(ms);
  return { local, theirs: sameClock ? null : `${theirs} their time` };
}

/** `Nov 9, 9:23 AM`: an instant in a history, where the date always matters. Null when unreadable. */
export function salesDateTime(iso: string | null, locale?: string): string | null {
  const ms = parse(iso);
  return Number.isNaN(ms)
    ? null
    : formatter(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(ms);
}

/**
 * What a screen kept from an earlier read says beside the error that followed it, or null with
 * no read to show.
 */
export function staleReadNote(readAt: string | null, now: number): string | null {
  const at = salesTime(readAt, now);
  return at === null ? null : `Showing what the engine said at ${at.local}.`;
}

/** A `YYYY-MM-DD` day as `Thu 12 Nov`, read as a calendar day with no zone. */
export function salesDay(day: string, locale?: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Number.isNaN(ms)
    ? day
    : formatter(locale, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(ms);
}
