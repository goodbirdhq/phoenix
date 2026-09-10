import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { EnvironmentUsageBucket } from "@t3tools/shared/usageMerge";
import { usageChartSeries } from "./chartSeries.ts";
import { usageReportSeries } from "./reportChartSeries.ts";
const bucket: EnvironmentUsageBucket = {
  environmentId: EnvironmentId.make("env"),
  environmentLabel: "Env",
  configuredInstanceIds: [],
  bucket: {
    day: UsageDay.make("2026-09-01"),
    sourceId: "home",
    provider: "codex",
    model: "model-a",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 10,
      reasoningTokens: 5,
    },
    costUsd: 2,
    cacheSavingsUsd: 1,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  },
};
describe("usage chart groups", () => {
  it("preserves totals across every grouping, including unmapped accounts and model switches", () => {
    const buckets = [
      bucket,
      { ...bucket, bucket: { ...bucket.bucket, model: "model-b", costUsd: 3 } },
    ];
    for (const grouping of ["provider", "account", "environment", "model"] as const) {
      const rows = usageChartSeries(buckets, [], ["2026-09-01", "2026-09-02"], grouping, "cost");
      expect(rows.reduce((sum, row) => sum + row.values[0]!, 0)).toBe(5);
      expect(rows.every((row) => row.values[1] === 0)).toBe(true);
    }
    expect(usageChartSeries(buckets, [], ["2026-09-01"], "provider", "tokens")[0]?.values).toEqual([
      90,
    ]);
  });
  it("counts creation times with no token usage and respects local calendar days", () => {
    const merged = {
      ...mergeUsage([], 6),
      threadCreations: [
        {
          environmentId: EnvironmentId.make("env"),
          threadId: "one",
          createdAt: "2026-09-02T01:00:00Z",
          instanceId: null,
        },
        {
          environmentId: EnvironmentId.make("env"),
          threadId: "two",
          createdAt: "2026-09-02T10:00:00Z",
          instanceId: null,
        },
      ],
    };
    expect(
      usageReportSeries(
        merged,
        [],
        ["2026-09-01", "2026-09-02"],
        "threads",
        "cost",
        "America/Los_Angeles",
        false,
      )[0]?.values,
    ).toEqual([1, 1]);
    expect(
      usageReportSeries(
        merged,
        [],
        ["2026-09-02T00:37:00.000Z", "2026-09-02T01:37:00.000Z"],
        "threads",
        "cost",
        "UTC",
        true,
      )[0]?.values,
    ).toEqual([1, 0]);
  });
});

it("bounds a crowded model legend while retaining every period and provider total", () => {
  const buckets = Array.from({ length: 20 }, (_, index) => ({
    ...bucket,
    bucket: { ...bucket.bucket, model: `model-${index}`, costUsd: index + 1 },
  }));
  const rows = usageChartSeries(buckets, [], ["2026-09-01", "2026-09-02"], "model", "cost");
  expect(rows).toHaveLength(6);
  expect(rows[0]?.label).toBe("model-19");
  expect(rows.at(-1)?.label).toBe("Other codex models");
  expect(rows.reduce((sum, row) => sum + row.values[0]!, 0)).toBe(210);
  expect(rows.every((row) => row.values[1] === 0)).toBe(true);
});

it("counts native sessions active in each interval independently of conversation creation", () => {
  const merged = {
    ...mergeUsage([], USAGE_CONTRACT_VERSION),
    sessionUsage: [
      {
        environmentId: EnvironmentId.make("env"),
        environmentLabel: "Env",
        provider: "codex" as const,
        sourceId: "home",
        sessionId: "one",
        firstActivityAt: "2026-09-01T00:00:00Z",
        lastActivityAt: "2026-09-02T00:00:00Z",
        models: [],
        periods: [
          { period: "2026-09-01", costUsd: 2, totalTokens: 10 },
          { period: "2026-09-02", costUsd: 3, totalTokens: 15 },
        ],
      },
      {
        environmentId: EnvironmentId.make("env"),
        environmentLabel: "Env",
        provider: "claude" as const,
        sourceId: "claude",
        sessionId: "two",
        firstActivityAt: "2026-09-01T00:00:00Z",
        lastActivityAt: "2026-09-01T00:00:00Z",
        models: [],
        periods: [{ period: "2026-09-01", costUsd: 4, totalTokens: 20 }],
      },
    ],
  };
  const periods = ["2026-09-01", "2026-09-02"];
  expect(
    usageReportSeries(merged, [], periods, "sessions", "cost", "UTC", false)[0]?.values,
  ).toEqual([2, 1]);
  expect(
    usageReportSeries(merged, [], periods, "sessions", "tokens", "UTC", true).map((row) => [
      row.provider,
      row.values,
    ]),
  ).toEqual([
    ["codex", [1, 1]],
    ["claude", [1, 0]],
  ]);
});
