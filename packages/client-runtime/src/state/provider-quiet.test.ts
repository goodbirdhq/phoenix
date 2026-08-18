import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_QUIET_AFTER_MS, resolveProviderQuietForMs } from "./provider-quiet.ts";

const lastReportedAt = "2026-01-01T00:00:00.000Z";
const lastReportedMs = Date.parse(lastReportedAt);

describe("resolveProviderQuietForMs", () => {
  it("stays silent while the provider is reporting normally", () => {
    expect(
      resolveProviderQuietForMs({
        lastReportedAt,
        nowMs: lastReportedMs + PROVIDER_QUIET_AFTER_MS - 1,
      }),
    ).toBeNull();
  });

  it("reports the full silence once past the threshold", () => {
    expect(
      resolveProviderQuietForMs({
        lastReportedAt,
        nowMs: lastReportedMs + 32 * 60 * 1_000,
      }),
    ).toBe(32 * 60 * 1_000);
  });

  it("clears itself as soon as the provider speaks again", () => {
    const freshlyReportedAt = "2026-01-01T00:40:00.000Z";
    const nowMs = Date.parse(freshlyReportedAt);
    expect(resolveProviderQuietForMs({ lastReportedAt, nowMs })).not.toBeNull();
    // The same instant, with a fresh report: no event had to retract anything.
    expect(resolveProviderQuietForMs({ lastReportedAt: freshlyReportedAt, nowMs })).toBeNull();
  });

  it("treats a clock behind the server as skew, not silence", () => {
    expect(
      resolveProviderQuietForMs({ lastReportedAt, nowMs: lastReportedMs - 60 * 60 * 1_000 }),
    ).toBeNull();
  });

  it("never invents a silence from missing or malformed input", () => {
    const nowMs = lastReportedMs + 60 * 60 * 1_000;
    expect(resolveProviderQuietForMs({ lastReportedAt: null, nowMs })).toBeNull();
    expect(resolveProviderQuietForMs({ lastReportedAt: undefined, nowMs })).toBeNull();
    expect(resolveProviderQuietForMs({ lastReportedAt: "not a date", nowMs })).toBeNull();
    expect(resolveProviderQuietForMs({ lastReportedAt, nowMs: Number.NaN })).toBeNull();
  });
});
