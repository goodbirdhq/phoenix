import {
  isProviderUsageLimitedForModel,
  resolveThreadBoundInstanceId,
} from "@t3tools/client-runtime/usage/thread-migration";
import {
  deriveThreadUsageWarning,
  formatUsageWarningReset,
  subscriptionAvailabilitySources,
  type ProviderAvailabilityEnvironment,
  type ThreadUsageWarning,
} from "@t3tools/client-runtime/usage/usage-warning";
import type { ProviderInstanceId } from "@t3tools/contracts";

export type MobileUsageWarningThread = {
  readonly id: string;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly session: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
};

/**
 * Mobile's small adapter from a thread shell and availability projection to
 * the shared warning derivation. The session is authoritative; persisted model
 * selection is only the fallback for threads without an instance-bound session.
 */
export function deriveMobileThreadUsageWarning(input: {
  readonly thread: MobileUsageWarningThread;
  readonly environmentId: string;
  readonly environments: readonly ProviderAvailabilityEnvironment[];
  readonly dismissedKeys?: ReadonlySet<string> | undefined;
  readonly nowMs?: number | undefined;
}): ThreadUsageWarning | null {
  const instanceId = resolveThreadBoundInstanceId({
    sessionProviderInstanceId: input.thread.session?.providerInstanceId,
    threadModelSelectionInstanceId: input.thread.modelSelection.instanceId,
  });
  const source = input.environments
    .find((environment) => environment.environmentId === input.environmentId)
    ?.providers.find((provider) => provider.instanceId === instanceId);
  // Yield only to the popup that actually replaces this warning: a pool that
  // does not constrain this thread's model leaves the warning as the honest
  // thing to say.
  if (isProviderUsageLimitedForModel(source?.availability, input.thread.modelSelection.model)) {
    return null;
  }
  return deriveThreadUsageWarning({
    threadId: input.thread.id,
    environmentId: input.environmentId,
    instanceId,
    sources: subscriptionAvailabilitySources(input.environments),
    dismissedKeys: input.dismissedKeys,
    nowMs: input.nowMs,
  });
}

/** Builds the single line rendered by the native warning pill. */
export function mobileUsageWarningLabel(
  warning: ThreadUsageWarning,
  options: { readonly nowMs?: number | undefined; readonly timeZone?: string | undefined } = {},
): string {
  const reset = formatUsageWarningReset(warning.resetsAt, options);
  return [
    `${warning.accountName} · ${Math.round(warning.usedPercent)}% used in ${warning.windowLabel.toLowerCase()}`,
    reset ? `resets ${reset}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One-shot wake-up for removing a warning as its window resets. */
export function usageWarningExpiryDelay(
  resetsAt: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  return Math.min(Math.max(0, resetMs - nowMs) + 50, MAX_TIMER_DELAY_MS);
}
