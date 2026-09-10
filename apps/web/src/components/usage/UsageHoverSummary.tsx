import { buildUsageAccounts } from "@t3tools/client-runtime/usage/accounts";
import { useMemo } from "react";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { useProviderAvailability } from "../../state/usage";
import { compareUsageAccountProviders } from "./usageAccountPresentation";
import { UsageQuotaSummary } from "./UsageQuotas";

export function UsageHoverSummary() {
  const environments = useProviderAvailability();
  const sources = useMemo(() => subscriptionAvailabilitySources(environments), [environments]);
  const accounts = useMemo(
    () => buildUsageAccounts(environments, []).toSorted(compareUsageAccountProviders),
    [environments],
  );
  return (
    <UsageQuotaSummary
      sources={sources}
      accounts={accounts}
      pendingEnvironmentIds={environments
        .filter((environment) => environment.isPending)
        .map((environment) => environment.environmentId)}
      refreshing={environments.some((environment) => environment.isRefreshing)}
    />
  );
}
