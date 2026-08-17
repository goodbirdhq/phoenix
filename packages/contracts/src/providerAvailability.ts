import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

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
  scope: Schema.optional(TrimmedNonEmptyString),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ProviderAvailabilityWindow = typeof ProviderAvailabilityWindow.Type;

// Present only when the native provider runtime supplies a stable account
// subject. Clients may group matching verified ids across environments, but
// MUST leave absent identities per configured instance (never merge by email,
// display name, provider kind, or plan).
export const ProviderAvailabilityAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  verification: Schema.Literal("native_verified"),
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAvailabilityAccount = typeof ProviderAvailabilityAccount.Type;

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
  windows: Schema.Array(ProviderAvailabilityWindow),
});
export type ProviderAvailability = typeof ProviderAvailability.Type;

// Kept non-empty because a typeless empty MCP/RPC input can make strict
// clients discard the whole server schema.
export const ProviderAvailabilityInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  // Explicit only: CLI quota probing is never tied to background health
  // checks. A typeless input also makes some strict MCP clients drop a server.
  refresh: Schema.optional(Schema.Boolean),
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
  providers: Schema.Array(ProviderAvailabilityEntry),
});
export type ProviderAvailabilityResult = typeof ProviderAvailabilityResult.Type;
