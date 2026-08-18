import { Schema } from "effect";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * The availability vocabulary this build understands.
 *
 * Version 1 is what already-deployed clients were compiled against: window
 * kinds were the closed pair `primary`/`secondary`, and `source` was one of
 * `codex_app_server`/`claude_agent_sdk`/`unsupported`. Those clients decode the
 * RPC result with their own schema, so a value outside that vocabulary does not
 * degrade their Usage page — it fails the whole response, blanking every
 * instance including the ones they could read.
 *
 * Version 2 opens `kind` to any provider-native key and adds the
 * `claude_cli_usage` source, the verified account subject, and the `stale`
 * marker.
 *
 * A caller sends the version it can decode; a server that speaks a higher
 * version narrows its answer with {@link narrowProviderAvailability}. Bump this
 * (and extend the narrowing) whenever a *value* an older client's schema would
 * reject is introduced. Purely additive optional *fields* do not need a bump:
 * struct decoding ignores keys it does not know.
 */
export const PROVIDER_AVAILABILITY_CONTRACT_VERSION = 2 as const;

/** The window kinds a version 1 client's schema accepts. */
const V1_WINDOW_KINDS: ReadonlySet<string> = new Set(["primary", "secondary"]);

// Availability is intentionally per configured provider instance. Two
// authenticated Claude or Codex instances may represent different accounts,
// and adding their quotas together would be misleading.
export const ProviderAvailabilityWindow = Schema.Struct({
  // Native providers do not share a universal window taxonomy. Codex calls
  // these primary/secondary, while Claude exposes a session window plus named
  // weekly pools (for example Fable). Keep the provider-native key stable and
  // give clients optional display metadata rather than guessing a plan.
  kind: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  // Distinguishes two windows of the same kind, such as one weekly pool per
  // model. Windows of one kind without a scope are the provider's only window
  // of that kind.
  scope: Schema.optional(TrimmedNonEmptyString),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ProviderAvailabilityWindow = typeof ProviderAvailabilityWindow.Type;

// Present only when the native provider runtime supplies a stable account
// subject — for Claude, the CLI's own `claude auth status` reading of the
// signed-in first-party account. Clients may group matching verified ids
// across environments, but MUST leave absent identities per configured
// instance (never merge by email, display name, provider kind, or plan).
export const ProviderAvailabilityAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  verification: Schema.Literal("native_verified"),
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAvailabilityAccount = typeof ProviderAvailabilityAccount.Type;

// Present only when the windows below are an earlier reading that a newer
// collection attempt on the same channel could not replace. A transient CLI
// failure must not blank bars a person is looking at, but the numbers are no
// longer confirmed and a client must be able to say so rather than presenting
// them as freshly observed. `observedAt` keeps naming when the *windows* were
// read; `attemptedAt` names the attempt that failed.
export const ProviderAvailabilityStale = Schema.Struct({
  // `refresh_failed` - the attempt produced nothing at all (a timeout, a
  //   non-zero exit, an unusable panel).
  // `refresh_empty` - the attempt reached the provider but rendered no quota
  //   rows.
  reason: Schema.Literals(["refresh_failed", "refresh_empty"]),
  attemptedAt: Schema.optional(IsoDateTime),
});
export type ProviderAvailabilityStale = typeof ProviderAvailabilityStale.Type;

export const ProviderAvailability = Schema.Struct({
  // "unknown" is the normal initial state: Phoenix does not manufacture a
  // provider session merely to ask for quota data.
  status: Schema.Literals(["available", "limited", "unknown"]),
  // Identifies the native channel, not an inferred subscription plan.
  source: Schema.Literals([
    "codex_app_server",
    "claude_agent_sdk",
    "claude_cli_usage",
    "unsupported",
  ]),
  observedAt: Schema.optional(IsoDateTime),
  account: Schema.optional(ProviderAvailabilityAccount),
  stale: Schema.optional(ProviderAvailabilityStale),
  // Window kinds grow as providers add pools, and an expired snapshot keeps
  // its source and account while dropping windows. A client that cannot read
  // one window must still render the rest.
  windows: ForwardCompatibleArray(ProviderAvailabilityWindow),
});
export type ProviderAvailability = typeof ProviderAvailability.Type;

/**
 * The same reading expressed in the vocabulary a caller at `contractVersion`
 * can decode. A caller at the current version gets the reading unchanged.
 *
 * An older caller keeps everything version 1 named — Codex's primary/secondary
 * windows survive intact — and loses only what its schema would reject: window
 * kinds it has no literal for, and a `source` it has no literal for. Dropping
 * those rows means the status derived from them no longer holds, so it falls
 * back to `unknown`: an older client is told "nothing I can say in your words",
 * which is what it showed before these sources existed, instead of being handed
 * a response it discards whole.
 *
 * Optional fields added since version 1 (`label`, `scope`, `account`, `stale`)
 * are left in place: an unknown key is ignored by struct decoding, so removing
 * them would buy nothing and cost newer readers of an older-versioned request.
 */
export const narrowProviderAvailability = (
  availability: ProviderAvailability,
  contractVersion: number | undefined,
): ProviderAvailability => {
  if ((contractVersion ?? 1) >= PROVIDER_AVAILABILITY_CONTRACT_VERSION) return availability;
  const source: ProviderAvailability["source"] =
    availability.source === "claude_cli_usage" ? "claude_agent_sdk" : availability.source;
  const windows = availability.windows.filter((window) => V1_WINDOW_KINDS.has(window.kind));
  const droppedWindows = windows.length !== availability.windows.length;
  if (source === availability.source && !droppedWindows) return availability;
  return {
    ...availability,
    // Status summarises the windows. Once some of them are gone the old summary
    // no longer describes what is being sent, so it is derived from what
    // survived by the same rule the collectors use.
    ...(droppedWindows
      ? {
          status: (windows.some((window) => window.usedPercent >= 100)
            ? "limited"
            : windows.length > 0
              ? "available"
              : "unknown") satisfies ProviderAvailability["status"],
        }
      : {}),
    source,
    windows,
  };
};

// Kept non-empty because a typeless empty MCP/RPC input can make strict
// clients discard the whole server schema.
export const ProviderAvailabilityInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  // Explicit only. A refresh runs the provider's own CLI, so it is requested by
  // a person looking at the numbers and never by a background health check.
  refresh: Schema.optional(Schema.Boolean),
  // The availability vocabulary the caller can decode. Absent means version 1,
  // which is exactly what an already-deployed client sends, so the server
  // narrows its answer for it without that client shipping anything.
  contractVersion: Schema.optional(NonNegativeInt),
});
export type ProviderAvailabilityInput = typeof ProviderAvailabilityInput.Type;

export const ProviderAvailabilityEntry = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  availability: ProviderAvailability,
});
export type ProviderAvailabilityEntry = typeof ProviderAvailabilityEntry.Type;

export const ProviderAvailabilityResult = Schema.Struct({
  // One instance a client cannot decode (a driver or source it does not know
  // yet) must not blank the whole Usage page.
  providers: ForwardCompatibleArray(ProviderAvailabilityEntry),
});
export type ProviderAvailabilityResult = typeof ProviderAvailabilityResult.Type;
