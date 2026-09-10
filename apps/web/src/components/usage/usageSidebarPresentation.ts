import type { ProviderAvailability, UsageProviderKind } from "@t3tools/contracts";
import { blockedSessionWindow, lastKnownUsageWindow } from "@t3tools/client-runtime/usage/quotas";

export function sidebarQuotaPresentation(
  provider: UsageProviderKind,
  availability?: ProviderAvailability,
) {
  const bars: { label: string; usedPercent: number; spark: boolean }[] = [];
  if (!availability || availability.source === "unsupported")
    return {
      bars,
      status:
        provider === "opencode" ? "Pay as you go · balance unavailable" : "Limits unavailable",
      warning: false,
    };
  const stale = !!availability.stale || availability.status === "unknown";
  const blocked = blockedSessionWindow(provider, availability);
  if (blocked) return { bars, status: "Session limit reached", warning: true };
  const main = lastKnownUsageWindow(provider, availability);
  if (main) {
    const label =
      provider === "codex"
        ? "Codex"
        : main.kind === "weekly"
          ? "Weekly"
          : main.kind === "session"
            ? "Session"
            : provider === "opencode" && main.kind === "monthly"
              ? "Monthly spend"
              : (main.label ?? main.kind);
    bars.push({ label, usedPercent: main.usedPercent, spark: false });
  }
  if (provider === "codex") {
    const spark =
      availability.windows.find(
        (window) =>
          window.kind === "primary" && /spark/i.test(`${window.scope ?? ""} ${window.label ?? ""}`),
      ) ??
      availability.windows.find((window) =>
        /spark/i.test(`${window.scope ?? ""} ${window.label ?? ""}`),
      );
    if (spark) bars.push({ label: "Spark", usedPercent: spark.usedPercent, spark: true });
  }
  if (stale)
    return {
      bars,
      status: bars.length ? "Last known · needs refresh" : "Limits need refresh",
      warning: false,
    };
  const session = availability.windows.find((window) => window.kind === "session" && !window.scope);
  if (provider === "claude" && session && session.usedPercent >= 90)
    return { bars, status: `Session ${Math.round(session.usedPercent)}% used`, warning: true };
  return { bars, status: bars.length ? null : "Limits unavailable", warning: false };
}
