import { describe, expect, it } from "vite-plus/test";

import { usagePlanKindLabel } from "./usage-plan-kind";

describe("usagePlanKindLabel", () => {
  it("renders only the provider-reported plan classification", () => {
    expect(usagePlanKindLabel("subscription")).toBe("Subscription");
    expect(usagePlanKindLabel("paygo")).toBe("Pay as you go");
    expect(usagePlanKindLabel("enterprise")).toBe("Enterprise");
  });

  it("treats an absent classification as unknown", () => {
    expect(usagePlanKindLabel(undefined)).toBe("Unknown");
    expect(usagePlanKindLabel("unknown")).toBe("Unknown");
  });
});
