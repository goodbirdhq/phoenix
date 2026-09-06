import { expect, it } from "vite-plus/test";
import { grokUsageFromResponse } from "./grokUsage.ts";
const at = "2026-09-06T00:00:00.000Z";
it("reads the unified weekly allowance and reset without treating a missing percentage as zero", () => {
  expect(
    grokUsageFromResponse(
      {
        config: {
          creditUsagePercent: 42,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: at },
        },
      },
      at,
    ).windows,
  ).toEqual([{ kind: "weekly", label: "Weekly", usedPercent: 42, resetsAt: at }]);
  expect(grokUsageFromResponse({ config: null }, at).status).toBe("unknown");
  expect(grokUsageFromResponse({ config: {} }, at).windows).toEqual([]);
  expect(grokUsageFromResponse({ config: { monthlyLimit: { val: 1000 } } }, at).windows).toEqual(
    [],
  );
  expect(() => grokUsageFromResponse({ config: { creditUsagePercent: "42" } }, at)).toThrow();
});
it("supports legacy cents, zero-valued proto fields and exhausted allowances", () => {
  expect(
    grokUsageFromResponse({ config: { monthlyLimit: { val: 1000 }, used: { val: 250 } } }, at)
      .windows[0]?.usedPercent,
  ).toBe(25);
  expect(
    grokUsageFromResponse({ config: { monthlyLimit: { val: 1000 }, used: {} } }, at).windows[0]
      ?.usedPercent,
  ).toBe(0);
  expect(
    grokUsageFromResponse({ config: { creditUsagePercent: 120 } }, at).windows[0]?.usedPercent,
  ).toBe(100);
  expect(grokUsageFromResponse({ config: { creditUsagePercent: 120 } }, at).status).toBe("limited");
  expect(grokUsageFromResponse({ config: { creditUsagePercent: -1 } }, at).windows).toEqual([]);
});
