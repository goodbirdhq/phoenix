import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import type { SubscriptionAvailabilitySource } from "@t3tools/client-runtime/usage/subscription-availability";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const usage = vi.hoisted(() => ({
  refreshUsage: vi.fn(),
  refreshCapacity: vi.fn(),
  useUsage: vi.fn(),
}));
const capacity = vi.hoisted(() => ({
  sources: [] as SubscriptionAvailabilitySource[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { readonly to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props} />
  ),
}));

vi.mock("../../state/usage", () => ({ useUsage: usage.useUsage }));
vi.mock("@t3tools/client-runtime/usage/usage-warning", () => ({
  subscriptionAvailabilitySources: () => capacity.sources,
}));

import { UsagePage } from "./UsagePage";

const studio = EnvironmentId.make("studio");
const laptop = EnvironmentId.make("laptop");

describe("UsagePage", () => {
  beforeEach(() => {
    usage.refreshUsage.mockReset();
    usage.refreshCapacity.mockReset();
    usage.useUsage.mockReset();
    capacity.sources = [
      {
        environmentId: studio,
        environmentLabel: "Studio",
        instanceId: "claude-primary",
        driver: "claudeAgent",
        displayName: "Claude Primary",
        failoverGroup: "work",
        enabled: true,
        authenticated: true,
        availabilityRefreshSupported: true,
        availability: {
          status: "available",
          source: "claude_cli_usage",
          observedAt: "2026-08-20T18:00:00.000Z",
          account: { id: "shared", verification: "native_verified", displayName: "Work plan" },
          windows: [{ kind: "session", label: "Current session", usedPercent: 24 }],
        },
      },
      {
        environmentId: studio,
        environmentLabel: "Studio",
        instanceId: "claude-backup",
        driver: "claudeAgent",
        displayName: "Claude Backup",
        failoverGroup: "work",
        enabled: true,
        authenticated: true,
        availabilityRefreshSupported: true,
        isRefreshing: true,
        availability: {
          status: "available",
          source: "claude_cli_usage",
          observedAt: "2026-08-20T18:00:00.000Z",
          account: { id: "shared", verification: "native_verified", displayName: "Work plan" },
          windows: [{ kind: "session", label: "Current session", usedPercent: 24 }],
        },
      },
      {
        environmentId: laptop,
        environmentLabel: "Laptop",
        instanceId: "claude-personal",
        driver: "claudeAgent",
        displayName: "Claude Personal",
        enabled: true,
        authenticated: false,
        availabilityRefreshSupported: true,
        availability: { status: "unknown", source: "claude_agent_sdk", windows: [] },
      },
      {
        environmentId: laptop,
        environmentLabel: "Laptop",
        instanceId: "codex-failed",
        driver: "codex",
        displayName: "Codex Failed",
        enabled: true,
        authenticated: true,
        availabilityRefreshSupported: false,
        availability: {
          status: "available",
          source: "codex_app_server",
          observedAt: "2026-08-20T17:00:00.000Z",
          stale: { reason: "refresh_failed", attemptedAt: "2026-08-20T18:00:00.000Z" },
          windows: [{ kind: "weekly", label: "Weekly", usedPercent: 65 }],
        },
      },
    ];
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    usage.useUsage.mockReturnValue({
      merged: { ...merged, costUsd: 42, totalTokens: 1_000 },
      allEnvironments: [
        { environmentId: studio, label: "Studio", isPending: false, error: null, summary: null },
        { environmentId: laptop, label: "Laptop", isPending: true, error: null, summary: null },
      ],
      environments: [
        { environmentId: studio, label: "Studio", isPending: false, error: null, summary: null },
        { environmentId: laptop, label: "Laptop", isPending: true, error: null, summary: null },
      ],
      isPending: false,
      isPartial: false,
      isUsageRefreshing: true,
      refreshUsage: usage.refreshUsage,
      refreshCapacity: usage.refreshCapacity,
      providerAvailability: [],
      isProviderAvailabilityPending: true,
      isCapacityRefreshing: true,
      hasProviderAvailabilityError: false,
    });
  });

  it("renders realistic multi-Environment Capacity above retained historical Usage", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup.indexOf('id="capacity-heading"')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('id="capacity-heading"')).toBeLessThan(markup.indexOf("Raw token cost"));
    expect(markup).toContain("$42.00*");
    expect(markup).toContain("Work plan");
    expect(markup).toContain("Provider not authenticated");
    expect(markup).toContain("Refresh failed — previous reading unconfirmed");
    expect(markup).toContain("Current session: 24% used");
    expect(markup).toContain("Studio");
    expect(markup).toContain("Laptop");
    expect(markup).toContain('id="historical-usage-environment"');
    expect(markup).toContain('<option value="studio">Studio</option>');
    expect(markup).toContain('<option value="laptop">Laptop</option>');
    expect(markup).toContain('aria-label="Refresh capacity"');
    expect(markup).toContain('aria-label="Refresh usage" aria-busy="true"');
    expect(markup).toContain('aria-label="Capacity lens"');
    expect(markup).toContain('aria-pressed="true"');
    expect(usage.useUsage).toHaveBeenCalledWith(expect.any(Object), null);
  });
});
