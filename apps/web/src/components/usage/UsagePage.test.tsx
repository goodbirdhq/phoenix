import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
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
  pageTab: "overview" as "overview" | "models",
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
          : initial === "overview"
            ? testState.pageTab
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
  useSearch: () => ({}),
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
vi.mock("./UsageBreakdownChart", () => ({ UsageBreakdownChart: "div" }));
vi.mock("./UsageReportChart", () => ({ UsageReportChart: "div" }));
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
  testState.pageTab = "overview";
  testState.useUsage.mockReturnValue({
    accounts: [],
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
    testState.pageTab = "models";

    const markup = renderToStaticMarkup(<UsagePage />);
    const body = markup.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";

    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts models by token usage when the token metric is selected", () => {
    testState.metric = "tokens";
    testState.pageTab = "models";

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
