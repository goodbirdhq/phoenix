import type { UsageSummary } from "@t3tools/contracts";
import type { UsageAccount } from "./accounts.ts";

/** Restricts history to stores associated exclusively with this account's local instances. */
export function scopeAccountHistory(
  summary: UsageSummary,
  environmentId: string,
  account: UsageAccount,
): UsageSummary {
  const members = new Set(
    account.memberships
      .filter((member) => member.environmentId === environmentId)
      .map((member) => String(member.provider.instanceId)),
  );
  const provider = account.driver === "claudeAgent" ? "claude" : account.driver;
  const sources = summary.sources.filter(
    (source) =>
      source.fingerprint.provider === provider &&
      source.id !== undefined &&
      source.configuredInstanceIds !== undefined &&
      source.configuredInstanceIds.length > 0 &&
      source.configuredInstanceIds.every((instanceId) => members.has(instanceId)),
  );
  const sourceIds = new Set(sources.map((source) => source.id));
  return {
    ...summary,
    sources,
    ...(summary.threadCreations === undefined
      ? {}
      : {
          threadCreations: summary.threadCreations.filter(
            (creation) => creation.instanceId !== null && members.has(creation.instanceId),
          ),
        }),
    ...(summary.sessionUsage === undefined
      ? {}
      : {
          sessionUsage: summary.sessionUsage.filter(
            (session) => session.provider === provider && sourceIds.has(session.sourceId),
          ),
        }),
    buckets: summary.buckets.filter(
      (bucket) =>
        bucket.provider === provider &&
        bucket.sourceId !== undefined &&
        sourceIds.has(bucket.sourceId),
    ),
  };
}
