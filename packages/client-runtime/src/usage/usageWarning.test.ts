import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadUsageWarning,
  formatUsageWarningReset,
  subscriptionAvailabilitySources,
  USAGE_WARNING_THRESHOLD,
  type ProviderAvailabilityEnvironment,
} from "./usageWarning.ts";
import type { SubscriptionAvailabilitySource } from "./subscriptionAvailability.ts";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const IN_TWO_HOURS = "2026-08-19T14:00:00.000Z";

const source = (
  overrides: Partial<SubscriptionAvailabilitySource> = {},
): SubscriptionAvailabilitySource => ({
  environmentId: "agents",
  environmentLabel: "Agents",
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  authenticated: true,
  availability: {
    status: "available",
    source: "claude_cli_usage",
    observedAt: "2026-08-19T11:55:00.000Z",
    windows: [
      { kind: "session", label: "Current session", usedPercent: 94, resetsAt: IN_TWO_HOURS },
    ],
  },
  ...overrides,
});

const warn = (input: Partial<Parameters<typeof deriveThreadUsageWarning>[0]> = {}) =>
  deriveThreadUsageWarning({
    threadId: "thread-1",
    environmentId: "agents",
    instanceId: "claudeAgent",
    sources: [source()],
    nowMs: NOW,
    ...input,
  });

describe("deriveThreadUsageWarning", () => {
  it("warns about the window the bound instance is nearly through", () => {
    expect(warn()).toMatchObject({
      instanceId: "claudeAgent",
      accountName: "Claude",
      windowLabel: "Current session",
      usedPercent: 94,
      resetsAt: IN_TWO_HOURS,
      isReadingUnconfirmed: false,
    });
  });

  it("names the account the provider verified rather than the instance", () => {
    expect(
      warn({
        sources: [
          source({
            availability: {
              ...source().availability,
              account: {
                id: "goodbird",
                verification: "native_verified",
                displayName: "neil@goodbird.ai",
              },
            },
          }),
        ],
      })?.accountName,
    ).toBe("neil@goodbird.ai");
  });

  it("stays silent below the threshold and speaks up exactly at it", () => {
    const at = (usedPercent: number) =>
      warn({
        sources: [
          source({
            availability: {
              ...source().availability,
              windows: [{ kind: "session", usedPercent, resetsAt: IN_TWO_HOURS }],
            },
          }),
        ],
      });

    expect(USAGE_WARNING_THRESHOLD).toBe(0.9);
    expect(at(89.9)).toBeNull();
    expect(at(90)).toMatchObject({ usedPercent: 90 });
  });

  it("ignores instances other than the one the thread is bound to", () => {
    expect(
      warn({
        sources: [source({ instanceId: "claudeAgent_b", displayName: "Claude B" })],
      }),
    ).toBeNull();
    expect(warn({ instanceId: null })).toBeNull();
    expect(warn({ threadId: null })).toBeNull();
  });

  it("does not read the same instance id on a different environment", () => {
    expect(warn({ environmentId: "mac" })).toBeNull();
  });

  it("requires a confirmed enabled and authenticated provider", () => {
    expect(warn({ sources: [source({ enabled: false })] })).toBeNull();
    expect(warn({ sources: [source({ authenticated: undefined })] })).toBeNull();
  });

  it("never warns about a window whose reset has already passed", () => {
    expect(
      warn({
        sources: [
          source({
            availability: {
              ...source().availability,
              windows: [{ kind: "session", usedPercent: 99, resetsAt: "2026-08-19T11:00:00.000Z" }],
            },
          }),
        ],
      }),
    ).toBeNull();
  });

  it("picks the most spent window, then the one resetting soonest", () => {
    const windows = [
      { kind: "weekly", label: "Weekly", usedPercent: 92, resetsAt: "2026-08-22T12:00:00.000Z" },
      { kind: "session", label: "Current session", usedPercent: 97, resetsAt: IN_TWO_HOURS },
      {
        kind: "opus",
        label: "Weekly (Opus)",
        usedPercent: 97,
        resetsAt: "2026-08-23T12:00:00.000Z",
      },
    ];
    expect(
      warn({
        sources: [source({ availability: { ...source().availability, windows } })],
      }),
    ).toMatchObject({ windowLabel: "Current session", usedPercent: 97 });
  });

  it("marks a reading the provider could not confirm as unconfirmed", () => {
    expect(
      warn({
        sources: [
          source({
            availability: {
              ...source().availability,
              stale: { reason: "refresh_failed", attemptedAt: "2026-08-19T11:59:00.000Z" },
            },
          }),
        ],
      }),
    ).toMatchObject({ isReadingUnconfirmed: true });
  });

  it("silences a dismissed window but warns again for the next one", () => {
    const first = warn();
    expect(first).not.toBeNull();
    const dismissedKeys = new Set([first!.dismissalKey]);

    expect(warn({ dismissedKeys })).toBeNull();
    // Same thread, same instance, next window: the reset moved, so the warning
    // is a new one.
    expect(
      warn({
        dismissedKeys,
        sources: [
          source({
            availability: {
              ...source().availability,
              windows: [
                {
                  kind: "session",
                  label: "Current session",
                  usedPercent: 91,
                  resetsAt: "2026-08-19T19:00:00.000Z",
                },
              ],
            },
          }),
        ],
      }),
    ).not.toBeNull();
    // Another thread on the same account has its own dismissal.
    expect(warn({ dismissedKeys, threadId: "thread-2" })).not.toBeNull();
  });
});

describe("subscriptionAvailabilitySources", () => {
  const environment = (
    overrides: Partial<ProviderAvailabilityEnvironment> = {},
  ): ProviderAvailabilityEnvironment => ({
    environmentId: "agents",
    label: "Agents",
    providers: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        availability: source().availability,
      },
    ],
    serverProviders: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude A",
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
    ...overrides,
  });

  it("pairs each availability entry with its provider's enabled and auth facts", () => {
    expect(subscriptionAvailabilitySources([environment()])).toMatchObject([
      {
        environmentId: "agents",
        environmentLabel: "Agents",
        instanceId: "claudeAgent",
        displayName: "Claude A",
        enabled: true,
        authenticated: true,
      },
    ]);
  });

  it("leaves an instance the provider projection has not described unauthenticated", () => {
    expect(subscriptionAvailabilitySources([environment({ serverProviders: null })])).toMatchObject(
      [{ displayName: "Claude", enabled: false, authenticated: false }],
    );
  });
});

describe("formatUsageWarningReset", () => {
  it("gives a local wall-clock time for a reset later today", () => {
    expect(formatUsageWarningReset(IN_TWO_HOURS, { nowMs: NOW, timeZone: "UTC" })).toBe("2:00 PM");
  });

  it("names the day when the reset is not today", () => {
    expect(
      formatUsageWarningReset("2026-08-22T09:30:00.000Z", { nowMs: NOW, timeZone: "UTC" }),
    ).toBe("Sat 9:30 AM");
  });

  it("has nothing to say when the provider reported no reset", () => {
    expect(formatUsageWarningReset(null, { nowMs: NOW })).toBeNull();
  });
});
