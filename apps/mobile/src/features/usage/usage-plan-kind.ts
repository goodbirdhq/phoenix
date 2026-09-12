import type { ProviderPlanKind } from "@t3tools/contracts";

/** Only provider-reported evidence classifies an account. Older servers intentionally read unknown. */
export function usagePlanKindLabel(planKind: ProviderPlanKind | undefined): string {
  switch (planKind ?? "unknown") {
    case "subscription":
      return "Subscription";
    case "paygo":
      return "Pay as you go";
    case "enterprise":
      return "Enterprise";
    case "unknown":
      return "Unknown";
  }
}
