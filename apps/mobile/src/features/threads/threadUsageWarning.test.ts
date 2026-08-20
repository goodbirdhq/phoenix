import type { ProviderAvailabilityEnvironment } from "@t3tools/client-runtime/usage/usage-warning";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAvailability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMobileThreadUsageWarning,
  mobileUsageWarningLabel,
  usageWarningExpiryDelay,
} from "./threadUsageWarning";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const RESET = "2026-08-19T14:00:00.000Z";

function availability(accountName: string): ProviderAvailability {
  return {
    status: "available",
    source: "claude_cli_usage",
    observedAt: "2026-08-19T11:55:00.000Z",
    account: {
      id: accountName,
      displayName: accountName,
      verification: "native_verified",
    },
    windows: [{ kind: "session", label: "Current session", usedPercent: 94, resetsAt: RESET }],
  };
}

const environment: ProviderAvailabilityEnvironment = {
  environmentId: "agents",
  label: "Agents",
  providers: [
    {
      instanceId: ProviderInstanceId.make("claude-bound"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Bound account",
      availability: availability("bound@example.com"),
    },
    {
      instanceId: ProviderInstanceId.make("claude-picker"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Picker account",
      availability: availability("picker@example.com"),
    },
  ],
  serverProviders: [
    {
      instanceId: ProviderInstanceId.make("claude-bound"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Bound account",
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-19T11:55:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: ProviderInstanceId.make("claude-picker"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Picker account",
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-19T11:55:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ],
};

describe("deriveMobileThreadUsageWarning", () => {
  it("targets the bound session instead of an unsaved picker selection", () => {
    const warning = deriveMobileThreadUsageWarning({
      thread: {
        id: "thread-1",
        modelSelection: { instanceId: ProviderInstanceId.make("claude-picker") },
        session: { providerInstanceId: ProviderInstanceId.make("claude-bound") },
      },
      environmentId: "agents",
      environments: [environment],
      nowMs: NOW,
    });

    expect(warning?.instanceId).toBe("claude-bound");
  });

  it("falls back to the persisted model selection before a session exists", () => {
    expect(
      deriveMobileThreadUsageWarning({
        thread: {
          id: "thread-1",
          modelSelection: { instanceId: ProviderInstanceId.make("claude-picker") },
          session: null,
        },
        environmentId: "agents",
        environments: [environment],
        nowMs: NOW,
      })?.instanceId,
    ).toBe("claude-picker");
  });

  it("yields to the hard-limit popup once an account is limited", () => {
    const limitedEnvironment: ProviderAvailabilityEnvironment = {
      ...environment,
      providers: environment.providers.map((provider) =>
        provider.instanceId === "claude-bound"
          ? {
              ...provider,
              availability: {
                ...provider.availability,
                status: "limited",
                windows: [
                  {
                    kind: "session",
                    usedPercent: 100,
                    resetsAt: RESET,
                  },
                ],
              },
            }
          : provider,
      ),
    };
    expect(
      deriveMobileThreadUsageWarning({
        thread: {
          id: "thread-1",
          modelSelection: { instanceId: ProviderInstanceId.make("claude-picker") },
          session: { providerInstanceId: ProviderInstanceId.make("claude-bound") },
        },
        environmentId: "agents",
        environments: [limitedEnvironment],
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe("mobileUsageWarningLabel", () => {
  it("renders the account, rounded percentage, local reset, and stale qualification", () => {
    expect(
      mobileUsageWarningLabel(
        {
          instanceId: "claude-bound",
          driver: "claudeAgent",
          accountName: "bound@example.com",
          windowLabel: "Current session",
          usedPercent: 93.6,
          resetsAt: RESET,
          isReadingUnconfirmed: true,
          dismissalKey: "warning-key",
        },
        { nowMs: NOW, timeZone: "UTC" },
      ),
    ).toBe("bound@example.com · 94% used in current session · resets 2:00 PM · last known reading");
  });
});

describe("usageWarningExpiryDelay", () => {
  it("schedules one wake-up just after reset, including when effect setup crosses the reset", () => {
    expect(usageWarningExpiryDelay(RESET, NOW)).toBe(2 * 60 * 60 * 1_000 + 50);
    expect(usageWarningExpiryDelay("2026-08-19T11:00:00.000Z", NOW)).toBe(50);
    expect(usageWarningExpiryDelay(null, NOW)).toBeNull();
    expect(usageWarningExpiryDelay("not-a-date", NOW)).toBeNull();
  });
});
