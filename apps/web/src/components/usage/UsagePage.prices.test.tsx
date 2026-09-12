import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pricesProps: null as null | { initialSelectedEnvironmentIds: unknown; usage: unknown },
}));

vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({ account: null }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));

const envStatus = {
  environmentId: EnvironmentId.make("test"),
  label: "Test",
  isPending: false,
  error: null,
  summary: null,
};
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    allEnvironments: [envStatus],
    selectedEnvironments: [envStatus],
    environments: [envStatus],
    accounts: [],
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    isPending: false,
    isPartial: false,
    isUsageRefreshing: false,
    refreshUsage: vi.fn(),
    refreshCapacity: vi.fn(),
    providerAvailability: [],
    isProviderAvailabilityPending: false,
    isCapacityRefreshing: false,
    hasProviderAvailabilityError: false,
  }),
}));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: "cost", windowDays: 30 }),
  saveUsagePagePreferences: vi.fn(),
}));

// Heavy sub-surfaces are not the subject: the entry point and its dialog seed are.
vi.mock("./UsageOverview", () => ({
  UsageOverview: () => null,
  UsageTotals: () => null,
  UsageMetricToggle: () => null,
}));
vi.mock("./UsageReportChart", () => ({ UsageReportChart: () => null }));
vi.mock("./UsageReport", () => ({ UsageReport: () => null }));
vi.mock("./UsageAccountHeader", () => ({ UsageAccountHeader: () => null }));
vi.mock("./UsageEnvironments", () => ({ UsageEnvironments: () => null }));
vi.mock("./UsageLimits", () => ({ UsageLimitsSection: () => null }));
vi.mock("./UsageQuotas", () => ({ UsageQuotas: () => null }));
vi.mock("./UsagePriceOverrides", () => ({
  UsagePriceOverrides: (props: { initialSelectedEnvironmentIds: unknown; usage: unknown }) => {
    state.pricesProps = props;
    return null;
  },
}));
vi.mock("../patterns/PageHeading", () => ({
  PageHeading: ({ actions }: { actions: unknown }) => actions,
}));

vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tabs", () => ({
  Tabs: "div",
  TabsList: "div",
  TabsTrigger: "div",
  TabsContent: "div",
}));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));

import { UsagePage } from "./UsagePage";

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  state.pricesProps = null;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens the model prices dialog from the toolbar, seeded to all environments by default", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  const openButton = renderer.root
    .findAllByProps({ "aria-label": "Model prices" })
    .filter((node) => node.type === "button")[0];
  expect(openButton).toBeTruthy();
  if (!openButton) throw new Error("Model prices button missing");

  await act(async () => {
    openButton.props.onClick();
  });

  expect(state.pricesProps).not.toBeNull();
  expect(state.pricesProps?.initialSelectedEnvironmentIds).toBeNull();
  expect(state.pricesProps?.usage).toEqual([envStatus]);
});
