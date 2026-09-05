import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ProviderAvailabilityEntry,
  UsageSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { buildUsageAccounts } from "./accounts.ts";

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude-a"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Work",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "person@example.com" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});
const reading = (instance: ServerProvider, id: string): ProviderAvailabilityEntry => ({
  instanceId: instance.instanceId,
  driver: instance.driver,
  availability: {
    status: "unknown",
    source: "claude_cli_usage",
    windows: [],
    account: { id, verification: "native_verified" },
  },
});
const environment = (
  environmentId: string,
  serverProviders: readonly ServerProvider[],
  providers: readonly ProviderAvailabilityEntry[] = [],
) => ({ environmentId, label: environmentId, serverProviders, providers });
const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const history = decodeSummary({
  contractVersion: 6,
  readAt: "2026-09-01T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-09-01",
  untilDay: "2026-09-01",
  buckets: [],
  sources: [
    {
      id: "source",
      fingerprint: {
        provider: "claude",
        hostId: "host",
        resolvedHomePath: "/history",
        volumeId: "volume",
      },
      configuredInstanceIds: ["claude-a", "claude-b"],
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
});

describe("usage accounts", () => {
  it("groups verified accounts while retaining every environment, instance and installed version", () => {
    const a = provider();
    const b = provider({ instanceId: ProviderInstanceId.make("claude-b"), version: "2.0.0" });
    const accounts = buildUsageAccounts(
      [
        environment("a", [a], [reading(a, "subject")]),
        environment("b", [b], [reading(b, "subject")]),
      ],
      [],
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.emails).toEqual(["person@example.com"]);
    expect(accounts[0]?.name).toBe("Work");
    expect(
      accounts[0]?.memberships.map((member) => [member.environmentId, member.provider.version]),
    ).toEqual([
      ["a", "1.0.0"],
      ["b", "2.0.0"],
    ]);
  });
  it("never uses matching emails to merge unverified accounts", () => {
    const accounts = buildUsageAccounts(
      [environment("a", [provider()]), environment("b", [provider()])],
      [],
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => !account.identityVerified)).toBe(true);
  });
  it("keeps separate organisations separate even with the same email", () => {
    const a = provider();
    expect(
      buildUsageAccounts(
        [
          environment("a", [a], [reading(a, "org-one")]),
          environment("b", [a], [reading(a, "org-two")]),
        ],
        [],
      ),
    ).toHaveLength(2);
  });
  it("keeps instances separate when identity comes only from a failed refresh snapshot", () => {
    const a = provider();
    const old = reading(a, "subject");
    const stale = {
      ...old,
      availability: {
        ...old.availability,
        stale: { reason: "refresh_failed" as const, attemptedAt: "2026-09-01T00:00:00.000Z" },
      },
    };
    const accounts = buildUsageAccounts(
      [environment("a", [a], [stale]), environment("b", [a], [stale])],
      [],
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => !account.identityVerified)).toBe(true);
  });
  it("does not inherit verified identity or email after logout", () => {
    const a = provider({ auth: { status: "unauthenticated", email: "former@example.com" } });
    const [account] = buildUsageAccounts(
      [environment("a", [a], [reading(a, "former-subject")])],
      [],
    );
    expect(account?.identityVerified).toBe(false);
    expect(account?.emails).toEqual([]);
    expect(account?.name).toBe("Work");
  });
  it("shows disabled and API-key instances without requiring email or quota support", () => {
    const a = provider({
      driver: ProviderDriverKind.make("grok"),
      enabled: false,
      auth: { status: "authenticated", type: "api_key", label: "xAI API key" },
    });
    const [account] = buildUsageAccounts([environment("a", [a])], []);
    expect(account?.name).toBe("Work");
    expect(account?.memberships[0]?.provider.auth.type).toBe("api_key");
    expect(account?.memberships[0]?.provider.enabled).toBe(false);
  });
  it("preserves shared-store membership without merging the two accounts", () => {
    const a = provider();
    const b = provider({ instanceId: ProviderInstanceId.make("claude-b") });
    const accounts = buildUsageAccounts(
      [environment("a", [a, b])],
      [{ environmentId: "a", summary: history }],
    );
    expect(accounts).toHaveLength(2);
    expect(
      accounts.every((account) => account.memberships[0]?.historySources[0] === history.sources[0]),
    ).toBe(true);
    expect(accounts.every((account) => account.memberships[0]?.historyMembershipKnown)).toBe(true);
  });
  it("keeps old history membership unknown instead of guessing from provider kind", () => {
    const old = {
      ...history,
      sources: history.sources.map(({ configuredInstanceIds: _ids, ...source }) => source),
    };
    const [account] = buildUsageAccounts(
      [environment("a", [provider()])],
      [{ environmentId: "a", summary: old }],
    );
    expect(account?.memberships[0]?.historyMembershipKnown).toBe(false);
    expect(account?.memberships[0]?.historySources).toEqual([]);
  });
  it("ignores quota identity from a different driver reusing the instance id", () => {
    const a = provider();
    const wrong = { ...reading(a, "subject"), driver: ProviderDriverKind.make("grok") };
    expect(buildUsageAccounts([environment("a", [a], [wrong])], [])[0]?.identityVerified).toBe(
      false,
    );
  });
  it("keeps keys and ordering stable when environments arrive in another order", () => {
    const inputs = [environment("b", [provider()]), environment("a", [provider()])];
    expect(buildUsageAccounts(inputs, [])).toEqual(buildUsageAccounts(inputs.toReversed(), []));
  });
});
