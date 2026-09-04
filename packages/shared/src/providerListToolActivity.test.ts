import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderListToolActivity,
  formatProviderListHeading,
  formatProviderListPreview,
  formatProviderListReadyLabel,
  formatProviderListWindows,
  providerListSummaryTone,
} from "./providerListToolActivity.ts";

const providersResult = {
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude A",
      available: true,
      availability: {
        status: "available",
        source: "claude_agent_sdk",
        windows: [
          { kind: "primary", usedPercent: 12 },
          { kind: "secondary", usedPercent: 88 },
        ],
      },
      models: [{ id: "opus", displayName: "Opus", isDefault: true }],
    },
    {
      instanceId: "codex_personal",
      driver: "codex",
      displayName: "Codex Personal",
      available: false,
      availability: { status: "unknown", source: "codex_app_server", windows: [] },
      models: [],
    },
  ],
};

const mcpCall = (tool: string, result: unknown) => ({
  item: { type: "mcp_tool_call", server: "phoenix", tool, result },
});

describe("deriveProviderListToolActivity", () => {
  it("derives the card payload from a Codex-shaped result", () => {
    expect(
      deriveProviderListToolActivity(mcpCall("list_session_providers", providersResult)),
    ).toEqual({
      totalCount: 2,
      providers: [
        {
          instanceId: "claudeAgent",
          displayName: "Claude A",
          driver: "claudeAgent",
          available: true,
          status: "available",
          windows: [
            { kind: "primary", usedPercent: 12 },
            { kind: "secondary", usedPercent: 88 },
          ],
        },
        {
          instanceId: "codex_personal",
          displayName: "Codex Personal",
          driver: "codex",
          available: false,
          status: "unknown",
          windows: [],
        },
      ],
    });
  });

  it("recognises the flattened provider tool name", () => {
    expect(
      deriveProviderListToolActivity({
        toolName: "mcp__phoenix__list_session_providers",
        result: providersResult,
      })?.providers.length,
    ).toBe(2);
  });

  it("reads a result delivered as JSON text content", () => {
    expect(
      deriveProviderListToolActivity(
        mcpCall("list_session_providers", {
          content: [{ text: JSON.stringify(providersResult) }],
        }),
      )?.providers.length,
    ).toBe(2);
  });

  it("reads structuredContent inside a Codex result", () => {
    expect(
      deriveProviderListToolActivity(
        mcpCall("list_session_providers", {
          content: [{ text: "{}" }],
          structuredContent: providersResult,
        }),
      )?.providers.length,
    ).toBe(2);
  });

  it("prefers the already-projected carrier field over re-deriving", () => {
    expect(
      deriveProviderListToolActivity({
        item: {
          type: "mcp_tool_call",
          server: "phoenix",
          tool: "list_session_providers",
          result: "Cr…",
        },
        providerListActivity: {
          totalCount: 1,
          providers: [
            {
              instanceId: "from-carrier",
              displayName: "From Carrier",
              driver: "claudeAgent",
              available: true,
              status: "limited",
              windows: [{ kind: "primary", usedPercent: 99 }],
            },
          ],
        },
      }),
    ).toEqual({
      totalCount: 1,
      providers: [
        {
          instanceId: "from-carrier",
          displayName: "From Carrier",
          driver: "claudeAgent",
          available: true,
          status: "limited",
          windows: [{ kind: "primary", usedPercent: 99 }],
        },
      ],
    });
  });

  it("keeps spawnability and quota status independent", () => {
    const carrier = deriveProviderListToolActivity(
      mcpCall("list_session_providers", {
        providers: [
          {
            instanceId: "ready-but-limited",
            driver: "claudeAgent",
            displayName: "Claude A",
            available: true,
            availability: {
              status: "limited",
              windows: [
                { kind: "primary", label: "Session", usedPercent: 12 },
                { kind: "weekly", label: "Weekly", usedPercent: 100 },
              ],
            },
          },
          {
            instanceId: "offline-ok-quota",
            driver: "codex",
            displayName: "Codex",
            available: false,
            availability: { status: "available", windows: [] },
          },
        ],
      }),
    );

    expect(carrier?.providers).toEqual([
      {
        instanceId: "ready-but-limited",
        displayName: "Claude A",
        driver: "claudeAgent",
        available: true,
        status: "limited",
        windows: [
          { kind: "primary", label: "Session", usedPercent: 12 },
          { kind: "weekly", label: "Weekly", usedPercent: 100 },
        ],
      },
      {
        instanceId: "offline-ok-quota",
        displayName: "Codex",
        driver: "codex",
        available: false,
        status: "available",
        windows: [],
      },
    ]);
  });

  it("ignores other tools and other servers", () => {
    expect(
      deriveProviderListToolActivity(mcpCall("spawn_session", providersResult)),
    ).toBeUndefined();
    expect(
      deriveProviderListToolActivity({
        item: {
          type: "mcp_tool_call",
          server: "other",
          tool: "list_session_providers",
          result: providersResult,
        },
      }),
    ).toBeUndefined();
    expect(
      deriveProviderListToolActivity({
        toolName: "mcp__phoenix__spawn_session",
        result: providersResult,
      }),
    ).toBeUndefined();
  });

  it("returns nothing for in-flight calls without a result", () => {
    expect(
      deriveProviderListToolActivity({
        item: {
          type: "mcp_tool_call",
          server: "phoenix",
          tool: "list_session_providers",
          status: "inProgress",
        },
      }),
    ).toBeUndefined();
  });

  it("returns nothing when providers is missing", () => {
    expect(deriveProviderListToolActivity(mcpCall("list_session_providers", {}))).toBeUndefined();
  });

  it("keeps an empty success as a zero-state card", () => {
    expect(
      deriveProviderListToolActivity(mcpCall("list_session_providers", { providers: [] })),
    ).toEqual({
      providers: [],
      totalCount: 0,
    });
  });

  it("strips model catalog from the carrier", () => {
    const carrier = deriveProviderListToolActivity(
      mcpCall("list_session_providers", providersResult),
    );
    for (const p of carrier?.providers ?? []) {
      expect((p as unknown as Record<string, unknown>).models).toBeUndefined();
      expect((p as unknown as Record<string, unknown>).availability).toBeUndefined();
    }
  });

  it("caps shown providers at 8 and records the true total", () => {
    const big = {
      providers: Array.from({ length: 20 }, (_, i) => ({
        instanceId: `p-${i}`,
        driver: "test",
        displayName: `P ${i}`,
        available: true,
        availability: {
          status: "available",
          windows: Array.from({ length: 10 }, (_, j) => ({ kind: `k-${j}`, usedPercent: j * 10 })),
        },
        models: [],
      })),
    };
    const carrier = deriveProviderListToolActivity(mcpCall("list_session_providers", big));
    expect(carrier?.providers.length).toBe(8);
    expect(carrier?.totalCount).toBe(20);
    expect(carrier?.providers[0]?.windows.length).toBe(4);
  });
});

describe("provider list copy", () => {
  it("names every bounded window instead of only the first", () => {
    expect(
      formatProviderListWindows([
        { kind: "primary", label: "Session", usedPercent: 12 },
        { kind: "weekly", usedPercent: 100 },
      ]),
    ).toBe("Session 12% · weekly 100%");
  });

  it("separates spawnability from quota in labels", () => {
    expect(formatProviderListReadyLabel(true)).toBe("ready");
    expect(formatProviderListReadyLabel(false)).toBe("offline");
  });

  it("does not let a spawnable instance hide limited quota in the heading", () => {
    const activity = {
      totalCount: 2,
      providers: [
        {
          instanceId: "a",
          displayName: "Claude A",
          driver: "claudeAgent",
          available: true,
          status: "limited" as const,
          windows: [{ kind: "weekly", usedPercent: 100 }],
        },
        {
          instanceId: "b",
          displayName: "Codex",
          driver: "codex",
          available: false,
          status: "available" as const,
          windows: [],
        },
      ],
    };
    expect(formatProviderListHeading(activity)).toBe("Providers · 1 ready · 1 limited");
    expect(providerListSummaryTone(activity)).toBe("warning");
    expect(formatProviderListPreview(activity)).toBe("1/2 ready · Claude A, Codex");
  });

  it("names a successful empty list instead of looking like a failed tool call", () => {
    const empty = { totalCount: 0, providers: [] };
    expect(formatProviderListHeading(empty)).toBe("Providers · none configured");
    expect(formatProviderListPreview(empty)).toBe("none configured");
    expect(providerListSummaryTone(empty)).toBe("neutral");
  });

  it("admits when the card is showing a truncated subset", () => {
    const activity = {
      totalCount: 12,
      providers: Array.from({ length: 8 }, (_, i) => ({
        instanceId: `p-${i}`,
        displayName: `P ${i}`,
        driver: "test",
        available: true,
        status: "available" as const,
        windows: [],
      })),
    };
    expect(formatProviderListHeading(activity)).toBe("Providers · showing 8 of 12 · 8 ready");
    expect(formatProviderListPreview(activity).startsWith("8 ready of 8 shown")).toBe(true);
  });
});
