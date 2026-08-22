import { describe, expect, it } from "vite-plus/test";

import { buildChartDays } from "./usageChartData";

describe("buildChartDays", () => {
  it("includes OpenCode in the mobile provider stack", () => {
    const [day] = buildChartDays(
      ["2026-08-07"],
      [
        {
          day: "2026-08-07",
          costUsd: 3,
          totalTokens: 300,
          byProvider: new Map([["opencode", { costUsd: 3, totalTokens: 300 }]]),
        },
      ],
      "tokens",
    );

    expect(day?.values).toContainEqual({ provider: "opencode", value: 300 });
    expect(day?.total).toBe(300);
  });
});
