import {
  deriveThreadUsageWarning,
  subscriptionAvailabilitySources,
} from "@t3tools/client-runtime/usage/usage-warning";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useProviderAvailability } from "../../state/usage";
import { UsageLimitWarningBanner } from "./UsageLimitWarningBanner";

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Resolves only the thread's persisted binding. Composer picker state is
 * deliberately absent from this boundary because it does not change a running
 * thread until the next turn is sent.
 */
export function resolveThreadUsageWarningInstanceId(input: {
  readonly sessionProviderInstanceId: string | null | undefined;
  readonly threadModelSelectionInstanceId: string | null | undefined;
}): string | null {
  return input.sessionProviderInstanceId ?? input.threadModelSelectionInstanceId ?? null;
}

/**
 * Owns the availability subscription and warning-local state so an unrelated
 * environment's availability update does not rerender ChatView.
 */
export const ThreadUsageWarning = memo(function ThreadUsageWarning({
  environmentId,
  instanceId,
  threadId,
}: {
  readonly environmentId: string | null;
  readonly instanceId: string | null;
  readonly threadId: string | null;
}) {
  const providerAvailability = useProviderAvailability();
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [resetInvalidationTick, setResetInvalidationTick] = useState(0);
  const sources = useMemo(
    () => subscriptionAvailabilitySources(providerAvailability),
    [providerAvailability],
  );
  const warning = useMemo(
    () =>
      deriveThreadUsageWarning({
        threadId,
        environmentId,
        instanceId,
        sources,
        dismissedKeys,
      }),
    [dismissedKeys, environmentId, instanceId, resetInvalidationTick, sources, threadId],
  );

  const resetsAt = warning?.resetsAt ?? null;
  useEffect(() => {
    if (resetsAt === null) return;
    const resetsAtMs = Date.parse(resetsAt);
    if (Number.isNaN(resetsAtMs)) return;
    // Keep exactly one timeout armed. The cap avoids signed 32-bit overflow;
    // a far-future reset re-arms after the capped one-shot invalidation.
    const delayMs = Math.min(Math.max(0, resetsAtMs - Date.now()) + 50, MAX_TIMEOUT_DELAY_MS);
    const timeoutId = window.setTimeout(
      () => setResetInvalidationTick((tick) => tick + 1),
      delayMs,
    );
    return () => window.clearTimeout(timeoutId);
  }, [resetInvalidationTick, resetsAt]);

  const dismissalKey = warning?.dismissalKey ?? null;
  const dismiss = useCallback(() => {
    if (dismissalKey === null) return;
    setDismissedKeys((keys) => new Set(keys).add(dismissalKey));
  }, [dismissalKey]);

  return <UsageLimitWarningBanner warning={warning} onDismiss={dismiss} />;
});
