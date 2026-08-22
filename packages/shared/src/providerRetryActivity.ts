/**
 * Provider-side retry notices ride in on `runtime.warning` activities whose
 * payload detail is `{ type: "retry", attempt, message }`. They are not
 * failures: the provider CLI is backing off and will try again on its own, and
 * the turn keeps running. Clients collapse a consecutive run of them into a
 * single row so an upstream wobble reads as one event instead of a wall of
 * red — see `providerRetrySummary` for the per-state copy.
 */

/** One retry notice, as an adapter emitted it. */
export interface ProviderRetryAttempt {
  readonly attempt: number;
  readonly message: string;
}

/** A consecutive run of retry notices, collapsed into one timeline row. */
export interface ProviderRetryGroup {
  /** Number of notices in the run. Counts rows, not the provider's own
   * attempt counter, which resets whenever the upstream error changes. */
  readonly attempts: number;
  /** Distinct failure messages across the run, in the order first seen. */
  readonly messages: ReadonlyArray<string>;
  /** The provider stopped retrying and the turn took a hard error. */
  readonly exhausted: boolean;
}

export type ProviderRetryState = "retrying" | "recovered" | "exhausted";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Reads a retry notice out of a `runtime.warning` activity payload. Returns
 * undefined for every other warning, which keeps unrelated warnings on their
 * existing one-row-per-notice presentation.
 *
 * Two adapters signal "backing off, will try again" today, in their own
 * shapes: OpenCode sends `session.status` with `{ type: "retry", attempt }`,
 * Codex flags its error notification with `willRetry`. Claude, Cursor and
 * Grok have no retry signal, so their warnings are left alone.
 */
export function deriveProviderRetryAttempt(payload: unknown): ProviderRetryAttempt | undefined {
  const detail = asRecord(asRecord(payload)?.detail);
  if (!detail || (detail.type !== "retry" && detail.willRetry !== true)) {
    return undefined;
  }
  const attempt = typeof detail.attempt === "number" && detail.attempt > 0 ? detail.attempt : 1;
  const message =
    typeof detail.message === "string" && detail.message.trim().length > 0
      ? detail.message.trim()
      : typeof asRecord(payload)?.message === "string"
        ? String(asRecord(payload)?.message).trim()
        : "";
  return { attempt, message: message.length > 0 ? message : "Provider request failed" };
}

/** Folds one more notice into a run. */
export function appendProviderRetryAttempt(
  group: ProviderRetryGroup | undefined,
  next: ProviderRetryAttempt,
): ProviderRetryGroup {
  const messages = group?.messages ?? [];
  return {
    attempts: (group?.attempts ?? 0) + 1,
    messages: messages.includes(next.message) ? messages : [...messages, next.message],
    exhausted: group?.exhausted ?? false,
  };
}

/**
 * A run that is still the newest thing in a live turn is retrying. Once the
 * turn moves on — another activity lands, or the turn settles — the retries
 * did their job, unless the provider gave up and raised a hard error.
 */
export function providerRetryState(
  group: ProviderRetryGroup,
  context: { readonly followedByActivity: boolean; readonly turnInProgress: boolean },
): ProviderRetryState {
  if (group.exhausted) return "exhausted";
  if (context.followedByActivity || !context.turnInProgress) return "recovered";
  return "retrying";
}

export function providerRetrySummary(group: ProviderRetryGroup, state: ProviderRetryState): string {
  const { attempts } = group;
  switch (state) {
    case "retrying":
      return `Reconnecting to the provider (attempt ${attempts})`;
    case "recovered":
      return `Provider connection recovered after ${attempts} ${attempts === 1 ? "retry" : "retries"}`;
    case "exhausted":
      return `Provider retries exhausted after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
  }
}

/** Expanded-row body: what actually went wrong, deduped. */
export function providerRetryDetail(group: ProviderRetryGroup): string {
  return group.messages.join("\n");
}
