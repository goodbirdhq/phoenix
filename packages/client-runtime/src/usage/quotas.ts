import type { ProviderAvailability, UsageProviderKind } from "@t3tools/contracts";

/** Selects a reported main pool, including stale readings that must be labelled last known. */
export function lastKnownUsageWindow(
  provider: UsageProviderKind,
  availability: ProviderAvailability,
) {
  if (availability.source === "unsupported") return undefined;
  const preferred = provider === "claude" || provider === "grok" ? "weekly" : "primary";
  return (
    availability.windows.find(
      (window) => window.kind === preferred && (!window.scope || window.scope === "all-models"),
    ) ??
    availability.windows.find((window) => !window.scope) ??
    // Never substitute a model-specific pool (such as Spark) for the account allowance.
    availability.windows.find((window) => window.scope === "all-models")
  );
}

/** A session lock overrides the normal long-term bar in compact presentations. */
export function blockedSessionWindow(
  provider: UsageProviderKind,
  availability: ProviderAvailability,
) {
  if (
    availability.stale ||
    availability.status === "unknown" ||
    availability.source === "unsupported"
  )
    return undefined;
  return availability.windows.find(
    (window) =>
      !window.scope &&
      window.usedPercent >= 100 &&
      (window.kind === "session" || (provider === "codex" && window.kind === "primary")),
  );
}
