import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import type { SubscriptionAvailabilitySource } from "@t3tools/client-runtime/usage/subscription-availability";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  refreshUsage: vi.fn(),
  refreshCapacity: vi.fn(),
  metric: "cost" as "cost" | "tokens",
  breakdown: "time" as "model" | "time",
}));
const capacity = vi.hoisted(() => ({
  sources: [] as SubscriptionAvailabilitySource[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: vi.fn((initial: unknown) => [
      typeof initial === "function"
        ? {
            days: 1,
            window: {
              sinceDay: "2026-08-10",
              untilDay: "2026-08-11",
              timeZone: "UTC",
              resolution: "hour",
              sinceTime: "2026-08-10T12:37:00.000Z",
              untilTime: "2026-08-11T12:37:00.000Z",
            },
          }
        : initial === "cost"
          ? testState.metric
          : initial === "model"
            ? testState.breakdown
            : initial,
      vi.fn(),
    ]),
  };
});

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("@t3tools/client-runtime/usage/usage-warning", () => ({
  subscriptionAvailabilitySources: () => capacity.sources,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { readonly to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props} />
  ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "div" }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";

const providerTotals = (codex: number, claude: number) =>
  new Map([
    ["codex", { costUsd: codex, totalTokens: codex * 1_000 }],
    ["claude", { costUsd: claude, totalTokens: claude * 1_000 }],
  ] as const);

const modelTotals = Object.freeze([
  {
    model: "expensive-model",
    provider: "claude" as const,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    costShare: 10 / 16,
  },
  {
    model: "token-heavy-model",
    provider: "codex" as const,
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    costShare: 5 / 16,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex" as const,
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    costShare: 1 / 16,
  },
]);

beforeEach(() => {
  testState.metric = "cost";
  testState.breakdown = "time";
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      models: modelTotals,
      hourly: [
        {
          day: "2026-08-10",
          hourStart: "2026-08-10T13:37:00.000Z",
          costUsd: 13,
          totalTokens: 13_000,
          byProvider: providerTotals(7, 6),
        },
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T11:37:00.000Z",
          costUsd: 11,
          totalTokens: 11_000,
          byProvider: providerTotals(6, 5),
        },
      ],
    },
    allEnvironments: [],
    environments: [],
    isPending: false,
    isPartial: false,
    isUsageRefreshing: false,
    refreshUsage: testState.refreshUsage,
    refreshCapacity: testState.refreshCapacity,
    providerAvailability: [],
    isProviderAvailabilityPending: false,
    isCapacityRefreshing: false,
    hasProviderAvailabilityError: false,
  });
});

describe("UsagePage hourly breakdown", () => {
  it("keeps recent activity visible first without empty hourly rows", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body.match(/<tr/g)).toHaveLength(2);
    expect(body).toContain("$11.00");
    expect(body).toContain("$13.00");
    expect(body.indexOf("$11.00")).toBeLessThan(body.indexOf("$13.00"));
  });

  it("keeps chronological ordering when the token metric is selected", () => {
    testState.metric = "tokens";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/\$11\.00.*\$13\.00/);
  });
});

describe("UsagePage model breakdown", () => {
  it("sorts models by cost when the cost metric is selected", () => {
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.breakdown = "model";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
    expect(modelTotals.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
    ]);
  });
});

const studio = EnvironmentId.make("studio");
const laptop = EnvironmentId.make("laptop");

describe("UsagePage", () => {
  beforeEach(() => {
    testState.refreshUsage.mockReset();
    testState.refreshCapacity.mockReset();
    testState.useUsage.mockReset();
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
    testState.useUsage.mockReturnValue({
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
      refreshUsage: testState.refreshUsage,
      refreshCapacity: testState.refreshCapacity,
      providerAvailability: [],
      isProviderAvailabilityPending: true,
      isCapacityRefreshing: true,
      hasProviderAvailabilityError: false,
    });
  });

  it("renders realistic multi-Environment Capacity above retained historical Usage", () => {
    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup.indexOf('id="capacity-heading"')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('id="capacity-heading"')).toBeLessThan(markup.indexOf("sessions"));
    expect(markup).toContain("$42.00");
    expect(markup).toContain("API estimate");
    expect(markup).toContain("Work plan");
    expect(markup).toContain("Provider not authenticated");
    expect(markup).toContain("Refresh failed — previous reading unconfirmed");
    expect(markup).toContain("Current session: 24% used");
    expect(markup).toContain("Studio");
    expect(markup).toContain("Laptop");
    expect(markup).toContain('aria-label="Historical usage environment"');
    expect(markup).toContain("All Environments");
    expect(markup).toContain('aria-label="Refresh capacity"');
    expect(markup).toContain('aria-label="Refresh usage"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="Capacity lens"');
    expect(markup).toContain('aria-pressed="true"');
    expect(testState.useUsage).toHaveBeenCalledWith(expect.any(Object), null);
  });
});
