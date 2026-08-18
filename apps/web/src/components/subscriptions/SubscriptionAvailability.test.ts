import { describe, expect, it } from "vite-plus/test";

import {
  deriveSubscriptionAccounts,
  subscriptionResetLabel,
  subscriptionWindowLabel,
  type SubscriptionAvailabilitySource,
} from "./SubscriptionAvailability";

const source = (
  overrides: Partial<SubscriptionAvailabilitySource> = {},
): SubscriptionAvailabilitySource => ({
  environmentId: "agents",
  environmentLabel: "agents",
  instanceId: "claude-a",
  driver: "claudeAgent",
  displayName: "Claude A",
  enabled: true,
  authenticated: true,
  availability: {
    status: "available",
    source: "claude_cli_usage",
    observedAt: "2026-08-17T18:00:00.000Z",
    windows: [
      { kind: "session", label: "Current session", usedPercent: 0 },
      { kind: "weekly", label: "All models", usedPercent: 76 },
      { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 72 },
    ],
  },
  ...overrides,
});

describe("subscriptionResetLabel", () => {
  it("uses reset timing rather than an expired remaining-time label", () => {
    expect(
      subscriptionResetLabel(
        { kind: "weekly", usedPercent: 76, resetsAt: "2026-08-17T18:01:00.000Z" },
        Date.parse("2026-08-17T18:00:15.000Z"),
      ),
    ).toBe("Resets in 1m");
    expect(
      subscriptionResetLabel(
        { kind: "weekly", usedPercent: 76, resetsAt: "2026-08-17T18:00:00.000Z" },
        Date.parse("2026-08-17T18:00:15.000Z"),
      ),
    ).toBe("Ready to refresh");
  });
});

describe("deriveSubscriptionAccounts", () => {
  it("keeps unverified instances separate even when their names match", () => {
    const accounts = deriveSubscriptionAccounts([
      source(),
      source({ environmentId: "mac", environmentLabel: "Neil's MacBook Pro" }),
    ]);

    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.environmentLabels)).toEqual([
      ["agents"],
      ["Neil's MacBook Pro"],
    ]);
  });

  it("groups only matching native-verified subjects and keeps the newest snapshot", () => {
    const accounts = deriveSubscriptionAccounts([
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

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: "Neil",
      environmentLabels: ["agents", "Neil's MacBook Pro"],
      hasDivergentSnapshots: true,
    });
    expect(accounts[0]?.availability.windows[0]?.usedPercent).toBe(80);
  });

  it("omits disabled, unauthenticated, unsupported, and unknown providers", () => {
    const accounts = deriveSubscriptionAccounts([
      source({ enabled: false }),
      source({ instanceId: "unauthenticated", authenticated: false }),
      source({
        instanceId: "cursor",
        availability: { status: "unknown", source: "unsupported", windows: [] },
      }),
      source({
        instanceId: "unknown",
        availability: { status: "unknown", source: "claude_agent_sdk", windows: [] },
      }),
    ]);

    expect(accounts).toEqual([]);
  });

  it("retains a legacy unknown reading but labels it as unconfirmed", () => {
    const accounts = deriveSubscriptionAccounts([
      source({
        availability: {
          ...source().availability,
          status: "unknown",
        },
      }),
    ]);

    expect(accounts).toMatchObject([{ isCurrentAvailabilityUnknown: true, isStale: false }]);
  });
});

describe("subscriptionWindowLabel", () => {
  it("preserves provider-native named model pools", () => {
    expect(subscriptionWindowLabel({ kind: "model-weekly", label: "Fable", usedPercent: 72 })).toBe(
      "Fable",
    );
  });
});
