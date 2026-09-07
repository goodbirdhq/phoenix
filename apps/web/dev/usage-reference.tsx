import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ProviderAvailabilityEntry,
} from "@t3tools/contracts";
import { buildUsageAccounts } from "@t3tools/client-runtime/usage/accounts";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { UsageSidebarNavView } from "../src/components/usage/UsageSidebarNav";
import { UsageQuotaSummary, UsageQuotas } from "../src/components/usage/UsageQuotas";
import type { EnvironmentProviderAvailabilityStatus } from "../src/state/usage";
import { SidebarProvider } from "../src/components/ui/sidebar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import "../src/index.css";
import "../src/components/usage/usage.css";

const definitions = [
  {
    id: "codex_personal",
    driver: "codex",
    name: "Codex · Personal",
    cost: 248.4,
    windows: [
      { kind: "primary", usedPercent: 32, resetsAt: "2026-09-07T18:20:00Z" },
      { kind: "primary", scope: "spark", usedPercent: 14 },
    ],
  },
  {
    id: "codex_work",
    driver: "codex",
    name: "Codex · Work",
    cost: 186.2,
    windows: [
      { kind: "primary", usedPercent: 61, resetsAt: "2026-09-07T19:10:00Z" },
      { kind: "primary", scope: "spark", usedPercent: 8 },
    ],
  },
  {
    id: "claude_team",
    driver: "claudeAgent",
    name: "Claude · Team",
    cost: 822.75,
    windows: [
      { kind: "weekly", usedPercent: 42, resetsAt: "2026-09-14T00:00:00Z" },
      { kind: "session", usedPercent: 92, resetsAt: "2026-09-07T18:45:00Z" },
    ],
  },
  { id: "opencode_local", driver: "opencode", name: "OpenCode · Local", cost: 27.25, windows: [] },
  { id: "grok_personal", driver: "grok", name: "Grok · Personal", cost: null, windows: [] },
] as const;
const providers: readonly ServerProvider[] = definitions.map((row) => ({
  instanceId: ProviderInstanceId.make(row.id),
  driver: ProviderDriverKind.make(row.driver),
  displayName: row.name,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-07T12:00:00Z",
  availabilityRefreshSupported: true,
  models: [],
  slashCommands: [],
  skills: [],
}));
const ready: readonly ProviderAvailabilityEntry[] = definitions.map((row, index) => ({
  instanceId: providers[index]!.instanceId,
  driver: providers[index]!.driver,
  availability: {
    status: "available",
    source:
      row.driver === "codex"
        ? "codex_app_server"
        : row.driver === "claudeAgent"
          ? "claude_cli_usage"
          : "unsupported",
    windows: row.windows,
    observedAt: "2026-09-07T12:00:00Z",
  },
}));
function App() {
  const [state, setState] = useState("ready");
  const [selected, setSelected] = useState<string>();
  const pending = state === "loading";
  const readings =
    state === "loading"
      ? []
      : ready.map((row) => ({
          ...row,
          availability:
            state === "stale" || state === "offline"
              ? { ...row.availability, status: "unknown" as const }
              : state === "exhausted" && row.driver === "claudeAgent"
                ? {
                    ...row.availability,
                    windows: row.availability.windows.map((window) =>
                      window.kind === "session" ? { ...window, usedPercent: 100 } : window,
                    ),
                  }
                : row.availability,
        }));
  const environment: EnvironmentProviderAvailabilityStatus = {
    environmentId: EnvironmentId.make("review"),
    label: "MacBook Pro",
    isConnected: state !== "offline",
    isPending: pending,
    hasError: state === "stale",
    isRefreshing: state === "refreshing",
    hasUnsettledRefresh: false,
    isBaseQueryRefreshing: false,
    refreshingInstanceIds:
      state === "refreshing" ? providers.map((provider) => provider.instanceId) : [],
    providers: readings,
    serverProviders: providers,
    providerInstances: {},
  };
  const environments = [
    environment,
    {
      ...environment,
      environmentId: EnvironmentId.make("review-secondary"),
      label: "Build server",
      providers: [],
      serverProviders: [],
    },
  ];
  const accounts = buildUsageAccounts(environments, []).toSorted(
    (a, b) =>
      definitions.findIndex((row) => row.name === a.name) -
      definitions.findIndex((row) => row.name === b.name),
  );
  const costs = new Map(
    accounts.map((account) => [
      account.key,
      pending ? null : definitions.find((row) => row.name === account.name)!.cost,
    ]),
  );
  const sources = subscriptionAvailabilitySources(environments);
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <div className="usage-surface flex min-h-screen w-full bg-background text-foreground">
          <aside
            data-review="sidebar"
            className="flex h-[900px] w-[344px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
          >
            <div className="flex h-[52px] shrink-0 items-center px-5 text-sm font-semibold">
              Phoenix
            </div>
            <UsageSidebarNavView
              accounts={accounts}
              costs={costs}
              environments={environments}
              historyPending={pending}
              selected={selected}
              select={setSelected}
            />
            <div className="h-14 shrink-0" />
          </aside>
          <main className="min-w-0 flex-1 space-y-8 p-8">
            <h1 className="text-2xl font-semibold">Usage design review</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              The production components with deterministic provider data. Sidebar body starts at
              y=52; native window controls and the app navigation footer are checked in the paired
              client. These controls are a development fixture, not an app route.
            </p>
            <div className="flex flex-wrap gap-2">
              {["ready", "loading", "refreshing", "stale", "offline", "exhausted"].map((value) => (
                <button
                  key={value}
                  className="rounded border px-3 py-2 text-sm aria-pressed:bg-muted"
                  aria-pressed={state === value}
                  onClick={() => setState(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="flex items-start gap-10">
              <section
                data-review="rollover"
                className="overflow-hidden rounded-[10px] border bg-popover shadow-lg"
              >
                <UsageQuotaSummary
                  sources={sources}
                  accounts={accounts}
                  pendingEnvironmentIds={pending ? ["review"] : []}
                  refreshing={state === "refreshing"}
                />
              </section>
              <div className="flex-1">
                <UsageQuotas
                  sources={sources.filter((source) => source.instanceId === "codex_personal")}
                  driver="codex"
                  isPending={pending}
                  isRefreshing={state === "refreshing"}
                  connected={state !== "offline"}
                  refreshFailed={state === "stale"}
                  onRefresh={() => setState("refreshing")}
                />
              </div>
            </div>
          </main>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
