import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, USAGE_CONTRACT_VERSION, UsageDay } from "@t3tools/contracts";
import { mergeUsage, type EnvironmentUsageBucket } from "@t3tools/shared/usageMerge";
import { usageOverviewRows } from "./usageOverviewRows";

function unpricedBucket(): EnvironmentUsageBucket {
  return {
    environmentId: EnvironmentId.make("env"),
    environmentLabel: "Env",
    configuredInstanceIds: [],
    bucket: {
      day: UsageDay.make("2026-09-01"),
      provider: "codex",
      model: "mystery-model",
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 2,
      unpricedRecords: 2,
      sessions: 1,
    },
  };
}

describe("Usage model table", () => {
  const merged = {
    ...mergeUsage([], USAGE_CONTRACT_VERSION),
    models: Array.from({ length: 12 }, (_, index) => ({
      provider: "codex" as const,
      model: `model-${index}`,
      costUsd: 12 - index,
      totalTokens: index * 100,
      records: 1,
      unpricedRecords: 0,
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
  it("keeps all-unpriced models distinct from zero-cost models", () => {
    const rows = usageOverviewRows(
      {
        ...merged,
        models: [
          {
            provider: "codex",
            model: "unpriced",
            costUsd: 0,
            totalTokens: 100,
            records: 1,
            unpricedRecords: 1,
            costShare: 0,
          },
        ],
      },
      [],
      [],
      "model",
      "cost",
    );
    expect(rows[0]?.costUnknown).toBe(true);
  });

  it("flags all-unpriced provider and account groupings as unknown, not zero", () => {
    const withUnpricedBuckets = {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      buckets: [unpricedBucket()],
    };
    for (const grouping of ["provider", "account"] as const) {
      const rows = usageOverviewRows(withUnpricedBuckets, [], ["2026-09-01"], grouping, "cost");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.costUnknown).toBe(true);
      expect(rows[0]?.unpricedRecords).toBe(2);
    }
  });
});
