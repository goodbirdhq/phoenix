import { Cron } from "croner";

/** Parked distance for a pattern with no next occurrence — see below. */
const FAR_FUTURE_MS = 100 * 365.25 * 24 * 60 * 60 * 1_000;

/**
 * The next occurrence of `cron` (interpreted in `timezone`) strictly after
 * `after`. `paused: true` and no callback mean the `Cron` instance never
 * schedules a real timer (croner only calls `.schedule()` internally when a
 * callback function is supplied) — this is pure computation.
 *
 * A pattern can have no next occurrence at all (e.g. a 7-part pattern whose
 * year has already passed); rather than surface `null` to callers that
 * expect a `Date` to store in `next_run_at`, park it far in the future so it
 * is not re-evaluated as "due" on every subsequent tick.
 */
export function nextCronOccurrence(cron: string, timezone: string, after: Date): Date {
  const next = new Cron(cron, { timezone, paused: true }).nextRun(after);
  return next ?? new Date(after.getTime() + FAR_FUTURE_MS);
}
