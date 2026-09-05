import {
  ProviderDriverKind,
  type UsageSummary,
  type UsageBucket,
  UsageDay,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopeAccountHistory } from "./accountHistory.ts";
import type { UsageAccount } from "./accounts.ts";
import { buildUsageAccounts, findUsageAccount, usageAccountMemberKey } from "./accounts.ts";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

const provider = (id: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: "1",
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
const a = provider("a");
const b = provider("b");
const account: UsageAccount = {
  key: "account",
  driver: a.driver,
  name: "Codex",
  emails: [],
  identityVerified: true,
  memberships: [
    {
      isConnected: true,
      environmentId: "env",
      environmentLabel: "Env",
      provider: a,
      historySources: [],
      historyMembershipKnown: true,
    },
  ],
};
const source = (id: string, ids?: string[]) => ({
  id,
  ...(ids ? { configuredInstanceIds: ids } : {}),
  fingerprint: { provider: "codex" as const, hostId: "host", resolvedHomePath: id, volumeId: id },
  status: "ok" as const,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});
const bucket = (sourceId?: string): UsageBucket => ({
  ...(sourceId ? { sourceId } : {}),
  provider: "codex",
  model: "model",
  day: UsageDay.make("2026-09-01"),
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  costUsd: 1,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  sessions: 1,
  unpricedRecords: 0,
});
const summary: UsageSummary = {
  contractVersion: 6,
  timeZone: "UTC",
  readAt: "2026-09-01T00:00:00.000Z",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-01"),
  sources: [
    source("own", ["a"]),
    source("other", ["b"]),
    source("shared", ["a", "b"]),
    source("old"),
  ],
  buckets: [bucket("own"), bucket("other"), bucket("shared"), bucket("old"), bucket()],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
};

describe("account history", () => {
  it("includes exclusive linked stores and leaves shared and unmapped data in the overall view", () => {
    const scoped = scopeAccountHistory(summary, "env", account);
    expect(scoped.buckets.map((row) => row.sourceId)).toEqual(["own"]);
    expect(scoped.sources.map((row) => row.id)).toEqual(["own"]);
    expect(summary.buckets).toHaveLength(5);
  });
  it("does not confuse equal instance ids on different environments", () => {
    expect(scopeAccountHistory(summary, "different", account).buckets).toEqual([]);
  });
  it("includes a shared store once when every instance belongs to the same verified account", () => {
    const grouped = {
      ...account,
      memberships: [...account.memberships, { ...account.memberships[0]!, provider: b }],
    };
    expect(scopeAccountHistory(summary, "env", grouped).buckets.map((row) => row.sourceId)).toEqual(
      ["own", "other", "shared"],
    );
  });
  it("keeps an instance's navigation target valid when provider identity becomes available", () => {
    const environments = [
      { environmentId: "env", label: "Env", serverProviders: [a], providers: [] },
    ];
    const before = buildUsageAccounts(environments, []);
    const selection = usageAccountMemberKey(before[0]!.memberships[0]!);
    const after = buildUsageAccounts(
      [
        {
          ...environments[0]!,
          providers: [
            {
              instanceId: a.instanceId,
              driver: a.driver,
              availability: {
                status: "unknown",
                source: "codex_app_server",
                windows: [],
                account: { id: "verified", verification: "native_verified" },
              },
            },
          ],
        },
      ],
      [],
    );
    expect(before[0]?.key).not.toBe(after[0]?.key);
    expect(findUsageAccount(after, selection)?.identityVerified).toBe(true);
  });
});

it("filters session details using the same exclusive stores as account totals", () => {
  const detailed = {
    ...summary,
    sessionUsage: ["own", "other", "shared"].map((sourceId) => ({
      provider: "codex" as const,
      sourceId,
      sessionId: "native",
      firstActivityAt: "2026-09-01T00:00:00Z",
      lastActivityAt: "2026-09-01T00:00:00Z",
      models: [],
    })),
  };
  expect(
    scopeAccountHistory(detailed, "env", account).sessionUsage?.map((session) => session.sourceId),
  ).toEqual(["own"]);
  expect(scopeAccountHistory(detailed, "another-env", account).sessionUsage).toEqual([]);
});
