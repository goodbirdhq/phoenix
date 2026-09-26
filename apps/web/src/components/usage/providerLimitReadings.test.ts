import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import type { SubscriptionAvailabilitySource } from "@t3tools/client-runtime/usage/subscription-availability";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerLimitReadings } from "./providerLimitReadings";

const windows = [
  { id: "monthly", kind: "monthly" as const, label: "Included usage", usedPercent: 40 },
];
const provider = (driver: string, usageLimits?: ServerProvider["usageLimits"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...(usageLimits ? { usageLimits } : {}),
});
const account = (member: ServerProvider): UsageAccount => ({
  key: member.instanceId,
  driver: member.driver,
  name: member.driver,
  emails: [],
  identityVerified: false,
  memberships: [
    {
      isConnected: true,
      environmentId: "env",
      environmentLabel: "Laptop",
      provider: member,
      historySources: [],
      historyMembershipKnown: true,
    },
  ],
});
const source = (
  member: ServerProvider,
  channel: SubscriptionAvailabilitySource["availability"]["source"],
): SubscriptionAvailabilitySource => ({
  environmentId: "env",
  environmentLabel: "Laptop",
  instanceId: member.instanceId,
  driver: member.driver,
  displayName: member.driver,
  enabled: true,
  authenticated: true,
  availability: { status: "unknown", source: channel, windows: [] },
});

describe("providerLimitReadings", () => {
  it("shows a signed-in Cursor account's dashboard limits when it has no availability channel", () => {
    const cursor = provider("cursor", { checkedAt: "2026-09-01T00:00:00.000Z", windows });
    expect(providerLimitReadings(account(cursor), [source(cursor, "unsupported")])).toEqual([
      { key: "env:cursor", label: "Laptop", driver: "cursor", windows },
    ]);
  });

  it("leaves providers with a native availability channel to their own readings", () => {
    const codex = provider("codex", { checkedAt: "2026-09-01T00:00:00.000Z", windows });
    expect(providerLimitReadings(account(codex), [source(codex, "codex_app_server")])).toEqual([]);
  });

  it("has nothing to show when the provider reported no windows", () => {
    const cursor = provider("cursor");
    expect(providerLimitReadings(account(cursor), [source(cursor, "unsupported")])).toEqual([]);
    expect(providerLimitReadings(undefined, [])).toEqual([]);
  });
});
