import type { UsageProviderKind } from "@t3tools/contracts";

export function usageProviderKind(driver: string): UsageProviderKind {
  switch (driver) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
    case "cursor":
      return "cursor";
    case "antigravity":
      return "antigravity";
    default:
      throw new Error(`Unsupported Usage provider: ${driver}`);
  }
}

/** Match the account navigation and rollover reading order in Paper. */
export function compareUsageAccountProviders(a: { driver: string }, b: { driver: string }) {
  const order = ["codex", "claude", "opencode", "grok", "cursor", "antigravity"];
  return order.indexOf(usageProviderKind(a.driver)) - order.indexOf(usageProviderKind(b.driver));
}
