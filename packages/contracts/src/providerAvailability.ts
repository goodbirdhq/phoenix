import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

// Availability is intentionally per configured provider instance. Two
// authenticated Claude or Codex instances may represent different accounts,
// and adding their quotas together would be misleading.
export const ProviderAvailabilityWindow = Schema.Struct({
  kind: Schema.Literals(["primary", "secondary"]),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ProviderAvailabilityWindow = typeof ProviderAvailabilityWindow.Type;

export const ProviderAvailability = Schema.Struct({
  // "unknown" is the normal initial state: Phoenix does not manufacture a
  // provider session merely to ask for quota data.
  status: Schema.Literals(["available", "limited", "unknown"]),
  // Identifies the native channel, not an inferred subscription plan.
  source: Schema.Literals(["codex_app_server", "claude_agent_sdk", "unsupported"]),
  observedAt: Schema.optional(IsoDateTime),
  windows: Schema.Array(ProviderAvailabilityWindow),
});
export type ProviderAvailability = typeof ProviderAvailability.Type;

// Kept non-empty because a typeless empty MCP/RPC input can make strict
// clients discard the whole server schema.
export const ProviderAvailabilityInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
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
