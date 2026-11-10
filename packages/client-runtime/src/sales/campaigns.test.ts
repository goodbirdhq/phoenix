import { describe, expect, it } from "vite-plus/test";

import { campaignName, withShare } from "./campaigns.ts";

describe("campaigns", () => {
  it("adds a share only when there is one to take", () => {
    expect(withShare(3, 12)).toBe("3 (25%)");
    expect(withShare(0, 12)).toBe("0");
    expect(withShare(3, 0)).toBe("3");
  });

  it("names the group of sends that carry no campaign", () => {
    expect(campaignName(null)).toBe("No campaign");
    expect(campaignName("Fintech Q4")).toBe("Fintech Q4");
  });
});
