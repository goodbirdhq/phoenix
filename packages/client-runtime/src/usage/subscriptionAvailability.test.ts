import { describe, expect, it } from "vite-plus/test";

import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
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

  it("treats an omitted enabled or authentication status as not yet known, not disabled", () => {
    expect(deriveSubscriptionLimits([source()])).toHaveLength(1);
    expect(deriveSubscriptionLimits([source({ enabled: false })])).toEqual([]);
    expect(deriveSubscriptionLimits([source({ authenticated: false })])).toEqual([]);
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

describe("providerLimitSourceName", () => {
  it("uses a readable name instead of an implementation identifier", () => {
    expect(providerLimitSourceName("claudeAgent")).toBe("Claude");
    expect(providerLimitSourceName("example_provider")).toBe("Example Provider");
  });
});
