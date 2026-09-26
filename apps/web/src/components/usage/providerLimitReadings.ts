import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import type { SubscriptionAvailabilitySource } from "@t3tools/client-runtime/usage/subscription-availability";

import type { ProviderLimitReading } from "./UsageQuotas";

/**
 * Limits for account members with no availability channel. Cursor reports its
 * dashboard quota on the provider snapshot instead, so without this the account
 * card would claim no reading while the Limits tab shows one.
 */
export function providerLimitReadings(
  account: UsageAccount | undefined,
  sources: readonly SubscriptionAvailabilitySource[],
): ProviderLimitReading[] {
  return (account?.memberships ?? []).flatMap((member) => {
    const windows = member.provider.usageLimits?.windows ?? [];
    const channel = sources.find(
      (source) =>
        source.environmentId === member.environmentId &&
        source.instanceId === member.provider.instanceId,
    );
    return windows.length > 0 && (!channel || channel.availability.source === "unsupported")
      ? [
          {
            key: `${member.environmentId}:${member.provider.instanceId}`,
            label: member.environmentLabel,
            driver: member.provider.driver,
            windows,
          },
        ]
      : [];
  });
}
