import { describe, expect, it } from "vite-plus/test";
import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { usageOverviewRows } from "./usageOverviewRows";

describe("Usage model table", () => {
  const merged = {
    ...mergeUsage([], USAGE_CONTRACT_VERSION),
    models: Array.from({ length: 12 }, (_, index) => ({
      provider: "codex" as const,
      model: `model-${index}`,
      costUsd: 12 - index,
      totalTokens: index * 100,
      records: 1,
      costShare: (12 - index) / 78,
    })),
  };
  it("keeps every model visible rather than using the chart's grouped Other rows", () => {
    const rows = usageOverviewRows(merged, [], [], "model", "cost");
    expect(rows).toHaveLength(12);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBe(78);
    expect(rows[0]?.label).toBe("model-0");
  });
  it("orders the complete table by the selected metric without mutating the input", () => {
    expect(usageOverviewRows(merged, [], [], "model", "tokens")[0]?.label).toBe("model-11");
    expect(merged.models[0]?.model).toBe("model-0");
  });
});
