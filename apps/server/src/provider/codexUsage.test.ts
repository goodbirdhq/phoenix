import { expect, it } from "vite-plus/test";
import { codexUsageFromResponse } from "./codexUsage.ts";

const now = "2026-09-06T00:00:00.000Z";
it("refreshes main and Spark pools without counting the legacy alias twice", () => {
  const main = { primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1788652800 } };
  const result = codexUsageFromResponse(
    {
      rateLimits: main,
      rateLimitsByLimitId: {
        codex: main,
        "codex-spark": {
          limitName: "Spark",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        },
      },
    },
    now,
  );
  expect(result.status).toBe("limited");
  expect(result.windows).toHaveLength(2);
  expect(result.windows[0]).toMatchObject({ kind: "primary", usedPercent: 28, resetsAt: now });
  expect(result.windows[0]?.scope).toBeUndefined();
  expect(result.windows[1]).toMatchObject({
    scope: "codex-spark",
    label: "Spark",
    usedPercent: 100,
  });
});
it("supports legacy single-pool reads and keeps empty readings unknown", () => {
  expect(
    codexUsageFromResponse(
      { rateLimits: { secondary: { usedPercent: 54, windowDurationMins: null, resetsAt: null } } },
      now,
    ).windows,
  ).toEqual([{ kind: "secondary", usedPercent: 54 }]);
  expect(codexUsageFromResponse({ rateLimits: {} }, now).status).toBe("unknown");
});
