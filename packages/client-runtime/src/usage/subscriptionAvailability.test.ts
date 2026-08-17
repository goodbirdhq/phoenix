import { describe, expect, it } from "vite-plus/test";

import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionAvailabilityPresentationState,
  type SubscriptionAvailabilitySource,
} from "./subscriptionAvailability.ts";

const source = (
  overrides: Partial<SubscriptionAvailabilitySource> = {},
): SubscriptionAvailabilitySource => ({
  environmentId: "agents",
  environmentLabel: "Agents",
  instanceId: "claude-a",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  authenticated: true,
  availability: {
    status: "available",
    source: "claude_cli_usage",
    observedAt: "2026-08-17T18:00:00.000Z",
    windows: [{ kind: "weekly", label: "All models", usedPercent: 76 }],
  },
  ...overrides,
});

describe("deriveSubscriptionLimits", () => {
  it("keeps providers separate until the provider reports a verified account identity", () => {
    const limits = deriveSubscriptionLimits([
      source(),
      source({ environmentId: "mac", environmentLabel: "Neil's MacBook Pro" }),
    ]);

    expect(limits).toHaveLength(2);
    expect(limits.map((limit) => limit.environmentLabels)).toEqual([
      ["Agents"],
      ["Neil's MacBook Pro"],
    ]);
    expect(limits.every((limit) => !limit.isAccount)).toBe(true);
  });

  it("groups only matching verified account identities and retains all environment provenance", () => {
    const limits = deriveSubscriptionLimits([
      source({
        availability: {
          ...source().availability,
          account: { id: "claude-subject", verification: "native_verified", displayName: "Neil" },
        },
      }),
      source({
        environmentId: "mac",
        environmentLabel: "Neil's MacBook Pro",
        instanceId: "claude-b",
        availability: {
          ...source().availability,
          observedAt: "2026-08-17T19:00:00.000Z",
          account: { id: "claude-subject", verification: "native_verified", displayName: "Neil" },
          windows: [{ kind: "weekly", label: "All models", usedPercent: 80 }],
        },
      }),
    ]);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      name: "Neil",
      isAccount: true,
      environmentLabels: ["Agents", "Neil's MacBook Pro"],
      hasDivergentSnapshots: true,
    });
    expect(limits[0]?.availability.windows[0]?.usedPercent).toBe(80);
  });

  it("requires a confirmed enabled and authenticated provider", () => {
    expect(deriveSubscriptionLimits([source()])).toHaveLength(1);
    expect(deriveSubscriptionLimits([source({ enabled: false })])).toEqual([]);
    expect(deriveSubscriptionLimits([source({ authenticated: false })])).toEqual([]);
  });

  it("keeps an expired provider snapshot visible without inventing quota bars", () => {
    const limits = deriveSubscriptionLimits([
      source({
        availability: {
          status: "unknown",
          source: "claude_cli_usage",
          observedAt: "2026-08-17T18:00:00.000Z",
          account: { id: "claude-subject", verification: "native_verified", displayName: "Neil" },
          windows: [],
        },
      }),
    ]);

    expect(limits).toMatchObject([
      { name: "Neil", isStale: true, isCurrentAvailabilityUnknown: true },
    ]);
  });

  it("marks legacy unknown snapshots with windows as unconfirmed instead of current", () => {
    const limits = deriveSubscriptionLimits([
      source({
        availability: {
          ...source().availability,
          status: "unknown",
        },
      }),
    ]);

    expect(limits).toMatchObject([{ isStale: false, isCurrentAvailabilityUnknown: true }]);
  });

  it("does not render an unknown authentication state as signed in", () => {
    expect(deriveSubscriptionLimits([source({ authenticated: undefined })])).toEqual([]);
  });

  it("flags changed provider labels as divergent readings", () => {
    const limits = deriveSubscriptionLimits([
      source({
        availability: {
          ...source().availability,
          account: { id: "claude-subject", verification: "native_verified", displayName: "Neil" },
        },
      }),
      source({
        environmentId: "mac",
        availability: {
          ...source().availability,
          account: { id: "claude-subject", verification: "native_verified", displayName: "Neil" },
          windows: [{ kind: "weekly", label: "All plans", usedPercent: 76 }],
        },
      }),
    ]);

    expect(limits[0]?.hasDivergentSnapshots).toBe(true);
  });
});

describe("subscriptionAvailabilityPresentationState", () => {
  it("keeps the loading copy visible until the provider projection supplies auth facts", () => {
    expect(
      subscriptionAvailabilityPresentationState({
        availabilityQueryPending: false,
        availabilityQueryFailed: false,
        providerProjectionReady: false,
      }),
    ).toEqual({ isPending: true, hasError: false });
  });

  it("reports a settled availability failure without calling it an empty result", () => {
    expect(
      subscriptionAvailabilityPresentationState({
        availabilityQueryPending: false,
        availabilityQueryFailed: true,
        providerProjectionReady: true,
      }),
    ).toEqual({ isPending: false, hasError: true });
  });
});

describe("providerLimitSourceName", () => {
  it("uses a readable name instead of an implementation identifier", () => {
    expect(providerLimitSourceName("claudeAgent")).toBe("Claude");
    expect(providerLimitSourceName("example_provider")).toBe("Example Provider");
  });
});
