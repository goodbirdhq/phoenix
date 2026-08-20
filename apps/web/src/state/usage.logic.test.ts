import { describe, expect, it } from "vite-plus/test";

import { selectHistoricalUsageEnvironments } from "./usage.logic";

const environments = [
  { environmentId: "studio", label: "Studio" },
  { environmentId: "laptop", label: "Laptop" },
] as const;

describe("selectHistoricalUsageEnvironments", () => {
  it("keeps All Environments as the default historical scope", () => {
    expect(selectHistoricalUsageEnvironments(environments, null)).toEqual(environments);
  });

  it("scopes historical usage to one Environment without changing the source list", () => {
    expect(selectHistoricalUsageEnvironments(environments, "laptop")).toEqual([
      { environmentId: "laptop", label: "Laptop" },
    ]);
    expect(environments).toHaveLength(2);
  });
});
