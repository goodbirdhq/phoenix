import { describe, expect, it } from "vite-plus/test";

import { deriveProviderListToolActivity } from "./providerListToolActivity.ts";

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

  it("returns nothing when providers is missing or empty", () => {
    expect(deriveProviderListToolActivity(mcpCall("list_session_providers", {}))).toBeUndefined();
    expect(
      deriveProviderListToolActivity(mcpCall("list_session_providers", { providers: [] })),
    ).toBeUndefined();
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

  it("caps at 8 providers and 4 windows", () => {
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
    expect(carrier?.providers[0]?.windows.length).toBe(4);
  });
});
