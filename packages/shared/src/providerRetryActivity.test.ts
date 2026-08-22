import { describe, expect, it } from "vite-plus/test";

import {
  appendProviderRetryAttempt,
  deriveProviderRetryAttempt,
  providerRetryState,
  providerRetrySummary,
} from "./providerRetryActivity.ts";

describe("deriveProviderRetryAttempt", () => {
  it("reads the retry notice adapters emit on runtime.warning", () => {
    expect(
      deriveProviderRetryAttempt({
        message: "Service Unavailable",
        detail: { type: "retry", attempt: 4, message: "Service Unavailable", next: 1787400945494 },
      }),
    ).toEqual({ attempt: 4, message: "Service Unavailable" });
  });

  it("ignores warnings that are not retries", () => {
    expect(deriveProviderRetryAttempt({ message: "Context compacted" })).toBeUndefined();
    expect(
      deriveProviderRetryAttempt({ message: "Truncated", detail: { stepFinishReason: "unknown" } }),
    ).toBeUndefined();
    expect(deriveProviderRetryAttempt(null)).toBeUndefined();
  });

  it("reads Codex's willRetry flag as the same signal", () => {
    expect(
      deriveProviderRetryAttempt({
        message: "stream disconnected before completion",
        detail: { willRetry: true, error: { message: "stream disconnected before completion" } },
      }),
    ).toEqual({ attempt: 1, message: "stream disconnected before completion" });

    expect(
      deriveProviderRetryAttempt({ message: "fatal", detail: { willRetry: false } }),
    ).toBeUndefined();
  });

  it("falls back to the warning message when the detail carries none", () => {
    expect(
      deriveProviderRetryAttempt({ message: "Upstream failed", detail: { type: "retry" } }),
    ).toEqual({ attempt: 1, message: "Upstream failed" });
  });
});

describe("provider retry rows", () => {
  const group = [
    { attempt: 1, message: "Service Unavailable" },
    { attempt: 2, message: "Service Unavailable" },
    { attempt: 1, message: "Provider finish_reason: network_error" },
  ].reduce(
    (acc, attempt) => appendProviderRetryAttempt(acc, attempt),
    undefined as ReturnType<typeof appendProviderRetryAttempt> | undefined,
  )!;

  it("counts notices and dedupes their messages", () => {
    expect(group).toEqual({
      attempts: 3,
      messages: ["Service Unavailable", "Provider finish_reason: network_error"],
      exhausted: false,
    });
  });

  it("reads as retrying only while it is the newest thing in a live turn", () => {
    const live = { followedByActivity: false, turnInProgress: true };
    expect(providerRetryState(group, live)).toBe("retrying");
    expect(providerRetrySummary(group, "retrying")).toBe(
      "Reconnecting to the provider (attempt 3)",
    );

    expect(providerRetryState(group, { ...live, followedByActivity: true })).toBe("recovered");
    expect(providerRetryState(group, { ...live, turnInProgress: false })).toBe("recovered");
    expect(providerRetrySummary(group, "recovered")).toBe(
      "Provider connection recovered after 3 retries",
    );
  });

  it("stays exhausted no matter what follows", () => {
    const exhausted = { ...group, exhausted: true };
    expect(providerRetryState(exhausted, { followedByActivity: true, turnInProgress: false })).toBe(
      "exhausted",
    );
    expect(providerRetrySummary(exhausted, "exhausted")).toBe(
      "Provider retries exhausted after 3 attempts",
    );
  });

  it("says retry and attempt in the singular", () => {
    const once = appendProviderRetryAttempt(undefined, {
      attempt: 1,
      message: "Service Unavailable",
    });
    expect(providerRetrySummary(once, "recovered")).toBe(
      "Provider connection recovered after 1 retry",
    );
    expect(providerRetrySummary(once, "exhausted")).toBe(
      "Provider retries exhausted after 1 attempt",
    );
  });
});
