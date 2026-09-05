import { buildUsageAccounts } from "@t3tools/client-runtime/usage/accounts";
import { useMemo } from "react";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { useProviderAvailability } from "../../state/usage";
import { UsageQuotaSummary } from "./UsageQuotas";

export function UsageHoverSummary() {
  const environments = useProviderAvailability();
  const sources = useMemo(() => subscriptionAvailabilitySources(environments), [environments]);
  const accounts = useMemo(() => buildUsageAccounts(environments, []), [environments]);
  return <UsageQuotaSummary sources={sources} accounts={accounts} />;
}
