import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import type { SubscriptionAvailabilitySource } from "@t3tools/client-runtime/usage/subscription-availability";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const usage = vi.hoisted(() => ({
  refreshUsage: vi.fn(),
  refreshCapacity: vi.fn(),
  useUsage: vi.fn(),
}));
const capacity = vi.hoisted(() => ({
  sources: [] as SubscriptionAvailabilitySource[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: reactHookHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/usage", () => ({ useUsage: usage.useUsage }));
vi.mock("@t3tools/client-runtime/usage/usage-warning", () => ({
  subscriptionAvailabilitySources: () => capacity.sources,
}));

import { SubscriptionAvailabilitySection } from "../subscriptions/SubscriptionAvailability";
import { UsagePage } from "./UsagePage";

const studio = EnvironmentId.make("studio");
const laptop = EnvironmentId.make("laptop");

function orderedLandmarks(node: unknown, landmarks: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) orderedLandmarks(child, landmarks);
    return landmarks;
  }
  if (typeof node === "string") {
    if (node === "Raw token cost") landmarks.push("activity");
    return landmarks;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return landmarks;
  if (node.type === SubscriptionAvailabilitySection) landmarks.push("capacity");
  for (const value of Object.values(node.props)) orderedLandmarks(value, landmarks);
  return landmarks;
}

describe("UsagePage", () => {
  beforeEach(() => {
    hooks.reset();
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

  it("keeps Capacity above historical Usage with independent refresh and Environment scope", () => {
    hooks.beginRender();
    const page = UsagePage();

    expect(orderedLandmarks(page)).toEqual(["capacity", "activity"]);
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("$42.00*");
    expect(markup).toContain("Work plan");
    expect(markup).toContain("Provider not authenticated");
    expect(markup).toContain("Refresh failed — previous reading unconfirmed");
    expect(markup).toContain("Current session: 24% used");
    expect(markup).toContain("Studio");
    expect(markup).toContain("Laptop");

    const capacity = visitElements(
      page,
      (element) => element.type === SubscriptionAvailabilitySection,
    );
    expect(capacity).not.toBeNull();
    (capacity!.props.onRefresh as () => void)();
    expect(usage.refreshCapacity).toHaveBeenCalledOnce();
    expect(usage.refreshUsage).not.toHaveBeenCalled();

    const historicalRefresh = visitElements(
      page,
      (element) => element.props["aria-label"] === "Refresh usage",
    );
    expect(historicalRefresh).not.toBeNull();
    expect(historicalRefresh!.props["aria-busy"]).toBe(true);
    (historicalRefresh!.props.onClick as () => void)();
    expect(usage.refreshUsage).toHaveBeenCalledOnce();
    expect(usage.refreshCapacity).toHaveBeenCalledOnce();

    const environmentSelect = visitElements(
      page,
      (element) => element.props.id === "historical-usage-environment",
    );
    expect(environmentSelect).not.toBeNull();
    (environmentSelect!.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: studio },
    });

    hooks.beginRender();
    UsagePage();
    expect(usage.useUsage.mock.calls.at(-1)?.[1]).toBe(studio);

    hooks.reset();
    hooks.beginRender();
    const capacityTree = SubscriptionAvailabilitySection(
      capacity!.props as Parameters<typeof SubscriptionAvailabilitySection>[0],
    );
    const instances = visitElements(
      capacityTree,
      (element) => element.props.children === "Instances",
    );
    expect(instances).not.toBeNull();
    (instances!.props.onClick as () => void)();
    hooks.beginRender();
    const instancesMarkup = renderToStaticMarkup(
      SubscriptionAvailabilitySection(
        capacity!.props as Parameters<typeof SubscriptionAvailabilitySection>[0],
      ),
    );
    expect(instancesMarkup).toContain("Claude Primary");
    expect(instancesMarkup).toContain("Claude Backup");
    expect(instancesMarkup).toMatch(/aria-pressed="true"[^>]*>Instances/u);
  });
});
