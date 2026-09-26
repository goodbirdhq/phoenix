import { EnvironmentId, ProviderInstanceId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { StrictMode, act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map(),
  refreshUsage: vi.fn(),
  refreshCapacity: vi.fn(),
  refreshProviders: vi.fn(async () => undefined),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ account: null }),
  useNavigate: () => state.navigate,
  useCanGoBack: () => false,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "keybindings" ? DEFAULT_RESOLVED_KEYBINDINGS : state.presentations,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: null },
  primaryServerKeybindingsAtom: "keybindings",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refreshProviders }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    accounts: [],
    allEnvironments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
        needsCursorKeychainAccess: false,
      },
    ],
    environments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
        needsCursorKeychainAccess: false,
      },
    ],
    selectedEnvironments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
        needsCursorKeychainAccess: false,
      },
    ],
    isPending: false,
    isPartial: false,
    isUsageRefreshing: false,
    refreshUsage: state.refreshUsage,
    refreshCapacity: state.refreshCapacity,
    providerAvailability: [],
    isProviderAvailabilityPending: false,
    isCapacityRefreshing: false,
    hasProviderAvailabilityError: false,
  }),
}));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: "limits", windowDays: 30 }),
  saveUsagePagePreferences: vi.fn(),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/tabs", async () => {
  const { createContext, useContext } = await import("react");
  const TabContext = createContext({ value: "", onValueChange: (_value: string) => {} });
  return {
    Tabs: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => <TabContext.Provider value={{ value, onValueChange }}>{children}</TabContext.Provider>,
    TabsList: "div",
    TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => {
      const tabs = useContext(TabContext);
      return (
        <button data-tab={value} onClick={() => tabs.onValueChange(value)}>
          {children}
        </button>
      );
    },
    TabsContent: ({ value, children }: { value: string; children: ReactNode }) =>
      useContext(TabContext).value === value ? children : null,
  };
});
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipPopup: "div", TooltipTrigger: "div" }));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverPopup: "div", PopoverTrigger: "div" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuCheckboxItem: "div",
  MenuItem: "div",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: "div",
}));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: "span" }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => ({ label: "Codex" }) }));

import { UsagePage } from "./UsagePage";

let renderer: ReactTestRenderer;
// Automatic limit checks are throttled per environment for the whole session,
// so every test reads its limits from a fresh environment id.
let environmentNumber = 0;
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { activeElement: null, querySelector: () => null });
  vi.stubGlobal("HTMLElement", function HTMLElement() {});
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  environmentNumber += 1;
  state.refreshUsage.mockClear();
  state.refreshCapacity.mockClear();
  state.refreshProviders.mockClear();
  state.navigate.mockClear();
  state.presentations = new Map([
    [
      EnvironmentId.make(`test-${environmentNumber}`),
      {
        entry: { target: { label: "Test" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-09-11T12:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-09-11T12:00:00Z",
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "Session",
                    usedPercent: 40,
                    windowDurationMins: 300,
                    resetsAt: "2026-09-11T14:00:00Z",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(): string {
  return JSON.stringify(renderer.toJSON(), (key, value) => (key === "props" ? undefined : value));
}

function selectTab(value: string): void {
  renderer.root.findByProps({ "data-tab": value }).props.onClick();
}

function clickRefresh(): void {
  renderer.root
    .findAllByProps({ "aria-label": "Refresh usage" })
    .filter((node) => node.type === "button")[0]!
    .props.onClick();
}

it("advances the limits countdown on refresh, even when quota is unchanged", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  await act(() => selectTab("limits"));
  expect(text()).toContain("in 2h 0m");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:30:00Z"));
  await act(async () => {
    clickRefresh();
  });
  expect(state.refreshCapacity).toHaveBeenCalled();
  expect(state.refreshUsage).toHaveBeenCalled();
  expect(state.refreshProviders).toHaveBeenLastCalledWith({
    environmentId: `test-${environmentNumber}`,
    input: {},
  });
  expect(text()).toContain("in 1h 30m");
  expect(text()).not.toContain("in 2h 0m");
});

it("recomputes the countdown when returning to Limits without refreshing", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  await act(() => selectTab("limits"));
  expect(text()).toContain("in 2h 0m");
  await act(() => selectTab("overview"));
  expect(text()).not.toContain("in 2h 0m");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T13:00:00Z"));
  await act(() => selectTab("limits"));
  expect(state.refreshUsage).not.toHaveBeenCalled();
  expect(state.refreshCapacity).not.toHaveBeenCalled();
  expect(text()).toContain("in 1h 0m");
  expect(text()).not.toContain("in 2h 0m");
});

it("refreshes limits once on opening Limits and suppresses rapid returns and remounts", async () => {
  await act(() => {
    renderer = create(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  expect(state.refreshProviders).not.toHaveBeenCalled();
  await act(() => selectTab("limits"));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => selectTab("overview"));
  await act(() => selectTab("limits"));
  await act(() => renderer.unmount());
  await act(() => {
    renderer = create(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  await act(() => selectTab("limits"));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => selectTab("overview"));
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:05:00Z"));
  await act(() => selectTab("limits"));
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("waits for connection and refreshes new environments during a slow limits refresh", async () => {
  const [id, presentation] = [...state.presentations][0]!;
  state.presentations = new Map([[id, { ...presentation, connection: { phase: "disconnected" } }]]);
  await act(() => {
    renderer = create(<UsagePage />);
  });
  await act(() => selectTab("limits"));
  expect(state.refreshProviders).not.toHaveBeenCalled();
  let finishRefresh!: () => void;
  state.refreshProviders.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
  );
  state.presentations = new Map([[id, presentation]]);
  await act(() => renderer.update(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  const nextId = EnvironmentId.make(`${id}-next`);
  state.presentations = new Map([...state.presentations, [nextId, presentation]]);
  await act(() => renderer.update(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
  expect(state.refreshProviders).toHaveBeenLastCalledWith({ environmentId: nextId, input: {} });
  await act(() => finishRefresh());
});

it("keeps manual refresh busy until the already-running automatic limits check settles", async () => {
  let finishRefresh!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finishRefresh = () => resolve(undefined);
  });
  state.refreshProviders.mockImplementationOnce(() => pending);
  await act(() => {
    renderer = create(<UsagePage />);
  });
  await act(() => selectTab("limits"));
  const button = () =>
    renderer.root
      .findAllByProps({ "aria-label": "Refresh usage" })
      .find((node) => node.type === "button")!;
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => button().props.onClick());
  try {
    expect(button().props["aria-busy"]).toBe(true);
    expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      finishRefresh();
      await pending;
    });
  }
  expect(button().props["aria-busy"]).toBeUndefined();
});

function press(key: string, init: KeyboardEventInit = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

it("switches views from the usage shortcuts", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  await act(() => press("l"));
  expect(text()).toContain("in 2h 0m");
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await act(() => press("t"));
  expect(text()).not.toContain("in 2h 0m");
  expect(
    renderer.root.findAll((node) => node.props["aria-label"] === "Usage metric")[0]!.props.value,
  ).toEqual(["tokens"]);
});

it("leaves the page on Escape and ignores repeats", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  press("Escape", { repeat: true });
  expect(state.navigate).not.toHaveBeenCalled();
  press("Escape");
  expect(state.navigate).toHaveBeenCalledWith({ to: "/" });
});
