import {
  deriveThreadUsageWarning,
  formatUsageWarningReset,
  subscriptionAvailabilitySources,
  type ProviderAvailabilityEnvironment,
  type ThreadUsageWarning,
} from "@t3tools/client-runtime/usage/usage-warning";

export type MobileUsageWarningThread = {
  readonly id: string;
  readonly modelSelection: { readonly instanceId: string };
  readonly session: { readonly providerInstanceId?: string | undefined } | null;
};

/**
 * Mobile's small adapter from a thread shell and availability projection to
 * the shared warning derivation. The model selection is deliberately ignored:
 * it may be an unsaved picker choice, while the session is the actual binding.
 */
export function deriveMobileThreadUsageWarning(input: {
  readonly thread: MobileUsageWarningThread;
  readonly environmentId: string;
  readonly environments: readonly ProviderAvailabilityEnvironment[];
  readonly dismissedKeys?: ReadonlySet<string> | undefined;
  readonly nowMs?: number | undefined;
}): ThreadUsageWarning | null {
  return deriveThreadUsageWarning({
    threadId: input.thread.id,
    environmentId: input.environmentId,
    instanceId: input.thread.session?.providerInstanceId ?? null,
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
    warning.isReadingUnconfirmed ? "last known reading" : null,
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
