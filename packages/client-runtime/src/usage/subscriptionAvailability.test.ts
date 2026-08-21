import { describe, expect, it } from "vite-plus/test";

import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionAvailabilityPresentationState,
  type SubscriptionAvailabilitySource,
  deriveSubscriptionCapacity,
  type SubscriptionCapacitySource,
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
  availabilityRefreshSupported: true,
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

  it("tags an account card with the instance it belongs to", () => {
    // Two Claude accounts: a card named after the person still has to say
    // which configured instance that is, or Settings and Usage cannot be
    // read against each other.
    const limits = deriveSubscriptionLimits([
      source({
        instanceId: "claudeAgent_claude_b",
        displayName: "Claude B",
        accentColor: "#16a34a",
        availability: {
          ...source().availability,
          account: {
            id: "goodbird",
            verification: "native_verified",
            displayName: "neil@goodbird.ai",
          },
        },
      }),
    ]);

    expect(limits).toMatchObject([
      {
        name: "neil@goodbird.ai",
        driver: "claudeAgent",
        instanceLabels: ["Claude B"],
        accentColor: "#16a34a",
      },
    ]);
  });

  it("does not repeat the instance name as a tag on its own card", () => {
    expect(deriveSubscriptionLimits([source()])).toMatchObject([
      { name: "Claude", instanceLabels: [] },
    ]);
  });

  it("hides a provider's windowless cards once one of its accounts reports quota", () => {
    // The agents environment could not read either Claude instance, but the
    // Mac read one of the accounts. The two "could not read" cards say nothing
    // the answered card does not.
    const unreadable = {
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: "2026-08-17T18:00:00.000Z",
      windows: [],
    } as const;
    const limits = deriveSubscriptionLimits([
      source({ instanceId: "claudeAgent", displayName: "Claude A", availability: unreadable }),
      source({ instanceId: "claudeAgent_b", displayName: "Claude B", availability: unreadable }),
      source({
        environmentId: "mac",
        environmentLabel: "Neil's MacBook Pro",
        instanceId: "claudeAgent_b",
        displayName: "Claude B",
        availability: {
          ...source().availability,
          account: {
            id: "goodbird",
            verification: "native_verified",
            displayName: "neil@goodbird.ai",
          },
        },
      }),
      // Codex read nothing anywhere, so its notice is the only answer it has.
      source({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        availability: unreadable,
      }),
    ]);

    expect(limits.map((limit) => limit.name)).toEqual(["Codex", "neil@goodbird.ai"]);
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

const capacitySource = (
  overrides: Partial<SubscriptionCapacitySource> = {},
): SubscriptionCapacitySource => ({
  ...source(),
  failoverGroup: "primary",
  ...overrides,
});

describe("deriveSubscriptionCapacity", () => {
  it("keeps failover groups local to an environment and provider", () => {
    const presentation = deriveSubscriptionCapacity([
      capacitySource(),
      capacitySource({ instanceId: "claude-b", environmentId: "agents", failoverGroup: "backup" }),
      capacitySource({
        instanceId: "claude-mac",
        environmentId: "mac",
        environmentLabel: "Neil's MacBook Pro",
        failoverGroup: "primary",
      }),
    ]);

    expect(presentation.groups.map((group) => group.key)).toEqual([
      "agents:claudeAgent:backup",
      "agents:claudeAgent:primary",
      "mac:claudeAgent:primary",
    ]);
  });

  it("creates an Ungrouped context and stable ordering for untagged instances", () => {
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        failoverGroup: undefined,
      }),
      capacitySource({ instanceId: "claude-untagged", failoverGroup: undefined }),
    ]);

    expect(presentation.groups.map((group) => [group.label, group.key])).toEqual([
      ["Ungrouped", "agents:claudeAgent:"],
      ["Ungrouped", "agents:codex:"],
    ]);
  });

  it("deduplicates only native-verified subscriptions in the Subscriptions lens", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "claude-a",
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-b",
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-c",
        availability: { ...source().availability, account: undefined },
      }),
    ]);

    const group = presentation.groups[0]!;
    expect(group.members).toHaveLength(2);
    expect(group.readinessCounts).toEqual({ available: 2, limited: 0, unknown: 0 });
    expect(group.members.find((member) => member.account !== undefined)?.instanceIds).toEqual([
      "claude-a",
      "claude-b",
    ]);
  });

  it("does not let a disabled shared-account backup demote a healthy subscription", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "claude-primary",
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-disabled",
        enabled: false,
        authenticated: false,
        availability: {
          ...source().availability,
          account,
          status: "unknown",
          observedAt: "2026-08-17T19:00:00.000Z",
        },
      }),
    ]);

    expect(presentation.readinessCounts).toEqual({ available: 1, limited: 0, unknown: 0 });
    expect(presentation.groups[0]?.members[0]?.readiness).toBe("available");
    expect(presentation.groups[0]?.members[0]?.availability.status).toBe("available");
  });

  it("preserves every instance and identifies shared subscriptions in the Instances lens", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity(
      [
        capacitySource({
          instanceId: "claude-a",
          availability: { ...source().availability, account },
        }),
        capacitySource({
          instanceId: "claude-b",
          availability: { ...source().availability, account },
        }),
      ],
      "instances",
    );

    const members = presentation.groups[0]!.members;
    expect(members).toHaveLength(2);
    expect(members.every((member) => member.sharedSubscription)).toBe(true);
    expect(members.map((member) => member.instanceLabels)).toEqual([["Claude"], ["Claude"]]);
  });

  it("lists only sibling labels for each shared-subscription instance row", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity(
      [
        capacitySource({
          instanceId: "claude-a",
          displayName: "Claude Primary",
          availability: { ...source().availability, account },
        }),
        capacitySource({
          instanceId: "claude-b",
          displayName: "Claude Backup",
          availability: { ...source().availability, account },
        }),
      ],
      "instances",
    );

    expect(
      presentation.groups[0]?.members.map((member) => [member.name, member.instanceLabels]),
    ).toEqual([
      ["Claude Backup", ["Claude Primary"]],
      ["Claude Primary", ["Claude Backup"]],
    ]);
  });

  it("keeps readiness subscription-based while the Instances lens expands routing rows", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity(
      [
        capacitySource({
          instanceId: "claude-a",
          availability: { ...source().availability, account },
        }),
        capacitySource({
          instanceId: "claude-b",
          availability: { ...source().availability, account, status: "limited" },
        }),
      ],
      "instances",
    );

    expect(presentation.readinessCounts).toEqual({ available: 0, limited: 1, unknown: 0 });
    expect(presentation.groups[0]?.readinessCounts).toEqual({
      available: 0,
      limited: 1,
      unknown: 0,
    });
    expect(presentation.providers).toEqual([
      {
        driver: "claudeAgent",
        readinessCounts: { available: 0, limited: 1, unknown: 0 },
        count: 1,
      },
    ]);
    expect(presentation.subscriptionCount).toBe(1);
    expect(presentation.instanceCount).toBe(2);
  });

  it("only offers targeted refresh for signed-in Providers that report limits", () => {
    const presentation = deriveSubscriptionCapacity([
      capacitySource(),
      capacitySource({
        instanceId: "signed-out",
        authenticated: false,
      }),
      capacitySource({
        instanceId: "unsupported",
        driver: "cursor",
        availability: { status: "unknown", source: "unsupported", windows: [] },
      }),
      capacitySource({
        instanceId: "passive-only",
        availabilityRefreshSupported: false,
      }),
    ]);

    expect(
      presentation.groups.flatMap((group) =>
        group.members.map((member) => [member.name, member.canRefresh]),
      ),
    ).toEqual([
      ["Claude", true],
      ["Claude", false],
      ["Claude", false],
      ["Claude", false],
    ]);
  });

  it("omits unsupported-only Providers from readiness summaries", () => {
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "unsupported",
        driver: "cursor",
        availability: { status: "unknown", source: "unsupported", windows: [] },
      }),
    ]);

    expect(presentation.providers).toEqual([]);
    expect(presentation.groups).toHaveLength(1);
  });

  it("keeps revalidation state on the affected subscription or instance row", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const sources = [
      capacitySource({
        instanceId: "claude-a",
        isRefreshing: true,
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-b",
        availability: { ...source().availability, account },
      }),
    ];

    expect(deriveSubscriptionCapacity(sources).groups[0]?.members[0]?.isRefreshing).toBe(true);
    expect(
      deriveSubscriptionCapacity(sources, "instances").groups[0]?.members.map(
        (member) => member.isRefreshing,
      ),
    ).toEqual([true, false]);
  });

  it("marks a retained failed reading unknown and keeps its refreshable instance", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "claude-disabled",
        enabled: false,
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-refreshable",
        availability: {
          ...source().availability,
          account,
          observedAt: "2026-08-17T19:00:00.000Z",
          stale: { reason: "refresh_failed", attemptedAt: "2026-08-17T19:00:00.000Z" },
        },
      }),
    ]);

    expect(presentation.readinessCounts).toEqual({ available: 0, limited: 0, unknown: 1 });
    expect(presentation.groups[0]?.members[0]).toMatchObject({
      readiness: "unknown",
      canRefresh: true,
      refreshInstanceId: "claude-refreshable",
    });
  });

  it("counts readiness from distinct subscriptions and retains native windows", () => {
    const account = {
      id: "limited",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity([
      capacitySource({ availability: { ...source().availability, account } }),
      capacitySource({
        instanceId: "claude-b",
        availability: {
          ...source().availability,
          status: "limited",
          account,
          windows: [{ kind: "weekly_pool", scope: "opus", label: "Opus weekly", usedPercent: 90 }],
        },
      }),
      capacitySource({
        instanceId: "claude-unknown",
        availability: { ...source().availability, status: "unknown", windows: [] },
      }),
    ]);

    expect(presentation.groups[0]?.readinessCounts).toEqual({
      available: 0,
      limited: 1,
      unknown: 1,
    });
    expect(
      presentation.groups[0]?.members.find((member) => member.account?.id === "limited")
        ?.availability.windows[0],
    ).toEqual(source().availability.windows[0]);
  });

  it("labels subscriptions that participate in multiple group contexts", () => {
    const account = {
      id: "shared",
      verification: "native_verified" as const,
      displayName: "Neil",
    };
    const presentation = deriveSubscriptionCapacity([
      capacitySource({
        instanceId: "claude-a",
        failoverGroup: "primary",
        availability: { ...source().availability, account },
      }),
      capacitySource({
        instanceId: "claude-b",
        failoverGroup: "secondary",
        availability: { ...source().availability, account },
      }),
    ]);

    expect(presentation.groups[0]?.members[0]?.crossContextMemberships).toEqual([
      expect.objectContaining({ key: "agents:claudeAgent:secondary", label: "secondary" }),
    ]);
  });
});
