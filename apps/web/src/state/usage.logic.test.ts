import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageSummaryInput,
} from "@t3tools/contracts";

import {
  capacityRefreshKey,
  hasUnsettledCapacityRefresh,
  parseCapacityRefreshKey,
  refreshHistoricalUsage,
  refreshProviderCapacity,
  resolveAvailabilityEntries,
  selectHistoricalUsageEnvironments,
  staleCapacityTargets,
  type UsageRefreshPorts,
} from "./usage.logic";

const environments = [
  { environmentId: EnvironmentId.make("studio"), label: "Studio" },
  { environmentId: EnvironmentId.make("laptop"), label: "Laptop" },
] as const;

describe("selectHistoricalUsageEnvironments", () => {
  it("keeps All Environments as the default historical scope", () => {
    expect(selectHistoricalUsageEnvironments(environments, null)).toEqual(environments);
  });

  it("scopes historical usage to one Environment without changing the source list", () => {
    expect(selectHistoricalUsageEnvironments(environments, "laptop")).toEqual([
      { environmentId: "laptop", label: "Laptop" },
    ]);
    expect(environments).toHaveLength(2);
  });
});

describe("Usage refresh orchestration", () => {
  const window = {
    sinceDay: "2026-08-01",
    untilDay: "2026-08-21",
    timeZone: "Europe/Berlin",
    resolution: "day",
  } as UsageSummaryInput;

  const makePorts = () => {
    const usage: unknown[] = [];
    const capacity: unknown[] = [];
    const ports: UsageRefreshPorts = {
      refreshUsageSummary: (target) => usage.push(target),
      refreshProviderAvailability: (target) => capacity.push(target),
    };
    return { ports, usage, capacity };
  };

  it("refreshes only historical summaries for the selected Environment", () => {
    const { ports, usage, capacity } = makePorts();

    refreshHistoricalUsage(ports, [environments[1]!], window);

    expect(usage).toEqual([{ environmentId: "laptop", input: window }]);
    expect(capacity).toEqual([]);
  });

  it("refreshes only Provider capacity for targeted instances", () => {
    const { ports, usage, capacity } = makePorts();
    const targets = [
      {
        environmentId: EnvironmentId.make("studio"),
        instanceId: ProviderInstanceId.make("claude-work"),
      },
    ];

    refreshProviderCapacity(ports, targets);

    expect(capacity).toEqual([
      {
        environmentId: "studio",
        input: { refresh: true, instanceId: "claude-work" },
      },
    ]);
    expect(usage).toEqual([]);
  });

  it("deduplicates and stably serializes in-flight capacity targets", () => {
    const studio = EnvironmentId.make("studio");
    const laptop = EnvironmentId.make("laptop");
    const claude = ProviderInstanceId.make("claude");
    const key = capacityRefreshKey([
      { environmentId: studio, instanceId: claude },
      { environmentId: laptop, instanceId: claude },
      { environmentId: studio, instanceId: claude },
    ]);

    expect(parseCapacityRefreshKey(key)).toEqual([
      { environmentId: "laptop", instanceId: "claude" },
      { environmentId: "studio", instanceId: "claude" },
    ]);
  });

  it("does not settle a refresh key before its query has produced an outcome", () => {
    expect(hasUnsettledCapacityRefresh([{ _tag: "Initial", waiting: false }])).toBe(true);
    expect(hasUnsettledCapacityRefresh([{ _tag: "Success", waiting: true }])).toBe(true);
    expect(hasUnsettledCapacityRefresh([{ _tag: "Success", waiting: false }])).toBe(false);
  });

  it("layers live updates and targeted refresh results over the cached snapshot", () => {
    const entry = (instanceId: string, usedPercent: number) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
      availability: {
        status: "available" as const,
        source: "codex_app_server" as const,
        windows: [{ kind: "primary", usedPercent }],
      },
    });

    expect(
      resolveAvailabilityEntries(
        [entry("codex-a", 10)],
        [entry("codex-a", 20), entry("codex-b", 30)],
        [[entry("codex-b", 40)]],
      ).map((value) => [value.instanceId, value.availability.windows[0]?.usedPercent]),
    ).toEqual([
      ["codex-a", 20],
      ["codex-b", 40],
    ]);
  });

  it("targets only refreshable readings that are missing or unconfirmed", () => {
    const environmentId = EnvironmentId.make("studio");
    const provider = (instanceId: string): ServerProvider =>
      ({
        instanceId: ProviderInstanceId.make(instanceId),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-08-21T10:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      }) as ServerProvider;
    const result = staleCapacityTargets([
      {
        environmentId,
        isPending: false,
        serverProviders: [provider("missing"), provider("fresh"), provider("stale")],
        providers: [
          {
            instanceId: ProviderInstanceId.make("fresh"),
            driver: ProviderDriverKind.make("claudeAgent"),
            availability: {
              status: "available",
              source: "claude_cli_usage",
              observedAt: "2026-08-21T10:00:00.000Z",
              windows: [{ kind: "session", usedPercent: 20 }],
            },
          },
          {
            instanceId: ProviderInstanceId.make("stale"),
            driver: ProviderDriverKind.make("claudeAgent"),
            availability: {
              status: "unknown",
              source: "claude_cli_usage",
              observedAt: "2026-08-21T09:00:00.000Z",
              windows: [{ kind: "session", usedPercent: 20 }],
            },
          },
        ],
      },
    ]);

    expect(result).toEqual([
      { environmentId: "studio", instanceId: "missing" },
      { environmentId: "studio", instanceId: "stale" },
    ]);
  });
});
