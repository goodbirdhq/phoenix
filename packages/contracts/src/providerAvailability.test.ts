import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAvailabilityResult } from "./providerAvailability.ts";
import { canRefreshProviderAvailability, type ServerProvider } from "./server.ts";

const decode = Schema.decodeUnknownSync(ProviderAvailabilityResult);

const claudeProvider = (overrides?: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claude-work",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.233",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-17T20:45:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

describe("ProviderAvailabilityResult", () => {
  it("keeps subscription windows on their configured provider instance", () => {
    const result = decode({
      providers: [
        {
          instanceId: "codex-personal",
          driver: "codex",
          displayName: "Personal",
          availability: {
            status: "available",
            source: "codex_app_server",
            observedAt: "2026-08-16T10:00:00.000Z",
            windows: [{ kind: "primary", usedPercent: 20, windowDurationMins: 300 }],
          },
        },
      ],
    });

    expect(result.providers[0]?.instanceId).toBe("codex-personal");
    expect(result.providers[0]?.availability.windows[0]?.usedPercent).toBe(20);
  });

  it("carries Claude's named weekly pools and its verified account", () => {
    const result = decode({
      providers: [
        {
          instanceId: "claude-work",
          driver: "claudeAgent",
          availability: {
            status: "available",
            source: "claude_cli_usage",
            observedAt: "2026-08-17T20:45:00.000Z",
            account: {
              id: "claude:org-1:maintainer@example.com",
              verification: "native_verified",
              displayName: "maintainer@example.com",
            },
            windows: [
              { kind: "session", label: "Current session", usedPercent: 5 },
              { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 72 },
            ],
          },
        },
      ],
    });

    expect(result.providers[0]?.availability.account?.verification).toBe("native_verified");
    expect(result.providers[0]?.availability.windows.map((window) => window.scope)).toEqual([
      undefined,
      "fable",
    ]);
  });

  it("drops an unreadable window or instance instead of blanking the page", () => {
    const result = decode({
      providers: [
        {
          instanceId: "claude-work",
          driver: "claudeAgent",
          availability: {
            status: "available",
            source: "claude_cli_usage",
            windows: [
              { kind: "session", usedPercent: 5 },
              { kind: "weekly", usedPercent: 420 },
            ],
          },
        },
        { instanceId: "broken", driver: "claudeAgent" },
      ],
    });

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.availability.windows).toEqual([
      { kind: "session", usedPercent: 5 },
    ]);
  });
});

describe("canRefreshProviderAvailability", () => {
  it("allows a refresh only for an installed, enabled, signed-in instance", () => {
    expect(canRefreshProviderAvailability(claudeProvider())).toBe(true);
    expect(canRefreshProviderAvailability(claudeProvider({ enabled: false }))).toBe(false);
    expect(canRefreshProviderAvailability(claudeProvider({ installed: false }))).toBe(false);
    expect(
      canRefreshProviderAvailability(claudeProvider({ auth: { status: "unauthenticated" } })),
    ).toBe(false);
    expect(canRefreshProviderAvailability(claudeProvider({ auth: { status: "unknown" } }))).toBe(
      false,
    );
    expect(canRefreshProviderAvailability(claudeProvider({ availability: "unavailable" }))).toBe(
      false,
    );
  });
});
