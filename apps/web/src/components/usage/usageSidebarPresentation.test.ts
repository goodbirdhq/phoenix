import { expect, it } from "vite-plus/test";
import type { ProviderAvailability } from "@t3tools/contracts";
import { sidebarQuotaPresentation } from "./usageSidebarPresentation";
const reading = (windows: ProviderAvailability["windows"]): ProviderAvailability => ({
  source: "codex_app_server",
  status: "available",
  windows,
});
it("separates the Codex main pool from Spark and does not relabel Spark as the main pool", () => {
  const windows = [
    { kind: "primary", scope: "codex_bengalfox", label: "GPT-5.3-Codex-Spark", usedPercent: 14 },
    { kind: "secondary", scope: "codex-spark", usedPercent: 5 },
    { kind: "primary", usedPercent: 32 },
  ];
  expect(sidebarQuotaPresentation("codex", reading(windows)).bars).toEqual([
    { label: "Codex", usedPercent: 32, spark: false },
    { label: "Spark", usedPercent: 14, spark: true },
  ]);
  expect(sidebarQuotaPresentation("codex", reading(windows.slice(0, 2))).bars).toEqual([
    { label: "Spark", usedPercent: 14, spark: true },
  ]);
});
it("shows the Claude weekly pool and near-limit session warning", () => {
  const result = sidebarQuotaPresentation(
    "claude",
    reading([
      { kind: "weekly", scope: "all-models", usedPercent: 42 },
      { kind: "session", usedPercent: 92 },
    ]),
  );
  expect(result).toEqual({
    bars: [{ label: "Weekly", usedPercent: 42, spark: false }],
    status: "Session 92% used",
    warning: true,
  });
});
it("shows a confirmed session lock alone, but retains stale bars without claiming a lock", () => {
  const current = reading([
    { kind: "weekly", usedPercent: 42 },
    { kind: "session", usedPercent: 100 },
  ]);
  expect(sidebarQuotaPresentation("claude", current)).toEqual({
    bars: [],
    status: "Session limit reached",
    warning: true,
  });
  expect(sidebarQuotaPresentation("claude", { ...current, status: "unknown" })).toEqual({
    bars: [{ label: "Weekly", usedPercent: 42, spark: false }],
    status: "Last known · needs refresh",
    warning: false,
  });
});
it("never invents a budget percentage for pay-as-you-go accounts", () => {
  expect(sidebarQuotaPresentation("opencode").bars).toEqual([]);
  expect(sidebarQuotaPresentation("grok").status).toBe("Limits unavailable");
});

it("shows Grok's reported weekly allowance and retains it as last known after a failed read", () => {
  const availability: ProviderAvailability = {
    source: "grok_acp",
    status: "available",
    windows: [{ kind: "weekly", usedPercent: 42 }],
  };
  expect(sidebarQuotaPresentation("grok", availability)).toEqual({
    bars: [{ label: "Weekly", usedPercent: 42, spark: false }],
    status: null,
    warning: false,
  });
  expect(sidebarQuotaPresentation("grok", { ...availability, status: "unknown" })).toMatchObject({
    bars: [{ label: "Weekly", usedPercent: 42, spark: false }],
    status: "Last known · needs refresh",
  });
});
