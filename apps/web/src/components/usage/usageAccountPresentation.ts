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
    default:
      throw new Error(`Unsupported Usage provider: ${driver}`);
  }
}
