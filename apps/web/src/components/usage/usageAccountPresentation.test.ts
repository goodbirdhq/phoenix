import { describe, expect, it } from "vite-plus/test";
import type { ProviderAvailability } from "@t3tools/contracts";
import { blockedSessionWindow, primaryUsageWindow } from "@t3tools/client-runtime/usage/quotas";

const availability = (windows: ProviderAvailability["windows"]): ProviderAvailability => ({
  status: "available",
  source: "claude_cli_usage",
  windows,
});

describe("sidebar quota selection", () => {
  it("uses Claude's overall weekly pool rather than a model-specific quota", () => {
    const reading = availability([
      { kind: "model-weekly", label: "Model", usedPercent: 90 },
      { kind: "session", usedPercent: 10 },
      { kind: "weekly", label: "All models", usedPercent: 40 },
    ]);
    expect(primaryUsageWindow("claude", reading)?.label).toBe("All models");
  });
  it("uses the reported Codex primary pool without combining a separate model quota", () => {
    const reading = availability([
      { kind: "model", label: "Spark", usedPercent: 95 },
      { kind: "primary", usedPercent: 20 },
    ]);
    expect(primaryUsageWindow("codex", reading)?.usedPercent).toBe(20);
  });
  it("does not present a stale or unsupported quota as current", () => {
    const reading = availability([{ kind: "weekly", usedPercent: 40 }]);
    expect(primaryUsageWindow("grok", { ...reading, source: "unsupported" })).toBeUndefined();
    expect(
      primaryUsageWindow("claude", {
        ...reading,
        stale: { reason: "refresh_failed", attemptedAt: "2026-09-01T00:00:00.000Z" },
      }),
    ).toBeUndefined();
    expect(primaryUsageWindow("opencode", availability([]))).toBeUndefined();
  });
});

it("recognizes Claude's explicitly scoped all-models pool", () => {
  const reading = availability([
    { kind: "session", usedPercent: 20 },
    { kind: "weekly", scope: "all-models", usedPercent: 50 },
  ]);
  expect(primaryUsageWindow("claude", reading)?.usedPercent).toBe(50);
});

it("prioritizes a reached session limit but does not mistake weekly or Spark exhaustion for it", () => {
  const weekly = availability([
    { kind: "weekly", usedPercent: 100 },
    { kind: "session", usedPercent: 30 },
  ]);
  expect(blockedSessionWindow("claude", weekly)).toBeUndefined();
  const locked = availability([
    { kind: "weekly", usedPercent: 40 },
    { kind: "session", usedPercent: 100 },
  ]);
  expect(blockedSessionWindow("claude", locked)?.kind).toBe("session");
  expect(
    blockedSessionWindow(
      "codex",
      availability([
        { kind: "primary", scope: "spark", usedPercent: 100 },
        { kind: "primary", usedPercent: 20 },
      ]),
    ),
  ).toBeUndefined();
  expect(
    blockedSessionWindow("claude", {
      ...locked,
      stale: { reason: "refresh_failed", attemptedAt: "2026-09-01T00:00:00.000Z" },
    }),
  ).toBeUndefined();
});
