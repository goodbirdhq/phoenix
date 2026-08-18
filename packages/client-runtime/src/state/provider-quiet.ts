/**
 * How long a working thread may go without any provider report before the UI
 * says how long it has been quiet.
 *
 * Kept short on purpose. The hint states a fact — nothing has arrived for N
 * minutes — rather than passing a verdict, so it costs nothing when the answer
 * is a slow build. A wedged agent and a long tool call are indistinguishable
 * from here, and only the user can tell them apart.
 */
export const PROVIDER_QUIET_AFTER_MS = 5 * 60 * 1_000;

/**
 * Milliseconds since the provider last reported, once that exceeds the
 * threshold; null while the thread is reporting normally.
 *
 * Derived from the session timestamp the shell already carries, so it needs no
 * event of its own and clears itself the moment the provider speaks again.
 */
export function resolveProviderQuietForMs(input: {
  readonly lastReportedAt: string | null | undefined;
  readonly nowMs: number;
  readonly quietAfterMs?: number;
}): number | null {
  if (input.lastReportedAt == null) return null;
  const lastReportedMs = Date.parse(input.lastReportedAt);
  // A malformed timestamp must not invent a silence: stay quiet about quiet.
  if (Number.isNaN(lastReportedMs) || !Number.isFinite(input.nowMs)) return null;
  const quietForMs = input.nowMs - lastReportedMs;
  const quietAfterMs = input.quietAfterMs ?? PROVIDER_QUIET_AFTER_MS;
  // A clock behind the server's yields a negative age; that is skew, not
  // silence.
  if (quietForMs < quietAfterMs) return null;
  return quietForMs;
}

/**
 * Formats a silence for display. Mirrors the working-duration format so a row
 * reads the same whichever of the two it is showing, on web and on mobile.
 */
export function formatProviderQuietLabel(quietForMs: number): string {
  const seconds = Number.isFinite(quietForMs) ? Math.max(0, Math.floor(quietForMs / 1_000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
