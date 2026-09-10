/**
 * The proactive "this account is nearly spent" warning shown in a chat view.
 *
 * A thread is bound to one provider instance, and that instance's subscription
 * windows already arrive with the availability reading the Usage page renders.
 * This module turns that reading into the single most urgent warning for one
 * thread, so every client can render the same sentence without repeating the
 * selection rules.
 *
 * @module usage/usageWarning
 */
import type {
  ProviderAvailability,
  ProviderAvailabilityEntry,
  ProviderAvailabilityWindow,
  ProviderInstanceConfigMap,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  providerLimitSourceName,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
} from "./subscriptionAvailability.ts";

/**
 * The share of a usage window that counts as "nearly spent".
 *
 * Deliberately not configurable in v1. A threshold people can move is one we
 * have to explain, persist, and support on every surface; a single honest
 * default is enough until real use tells us where it belongs.
 */
export const USAGE_WARNING_THRESHOLD = 0.9;

/** One thread's most urgent nearly-spent window, ready to render. */
export type ThreadUsageWarning = {
  readonly instanceId: string;
  readonly driver: string;
  /** Account name when the provider supplied one, otherwise the instance's name. */
  readonly accountName: string;
  /** The window's own name ("Current session", "Weekly"), never a plan guess. */
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  /**
   * Identity of this warning for dismissal. Carries the thread, the instance,
   * the window, and either its reset or reset-less usage bucket, so dismissing
   * it silences exactly this reading and a later window can warn again.
   */
  readonly dismissalKey: string;
};

/** The per-environment availability read every client already holds. */
export type ProviderAvailabilityEnvironment = {
  readonly environmentId: string;
  readonly label: string;
  readonly providers: readonly ProviderAvailabilityEntry[];
  /** Null until the provider projection lands; enabled/auth facts live here. */
  readonly serverProviders: readonly ServerProvider[] | null;
  /** Configured instance metadata supplies Environment-local Failover-group membership. */
  readonly providerInstances?: ProviderInstanceConfigMap | undefined;
  /** Instance ids with an explicit or stale revalidation currently in flight. */
  readonly refreshingInstanceIds?: readonly string[] | undefined;
};

const emptyAvailabilityForDriver = (driver: string): ProviderAvailability => ({
  status: "unknown",
  source:
    driver === "codex"
      ? "codex_app_server"
      : driver === "claudeAgent"
        ? "claude_agent_sdk"
        : driver === "grok"
          ? "grok_acp"
          : "unsupported",
  windows: [],
});

/**
 * Pairs each environment's availability entries with the enabled/authenticated
 * facts from its provider projection. An unknown status must never read as
 * signed in, so an instance missing from the projection stays unauthenticated.
 */
export function subscriptionAvailabilitySources(
  environments: readonly ProviderAvailabilityEnvironment[],
): readonly SubscriptionAvailabilitySource[] {
  return environments.flatMap((environment) => {
    const configuredIds =
      environment.serverProviders === null
        ? null
        : new Set(environment.serverProviders.map((provider) => provider.instanceId));
    const entries = new Map(
      environment.providers
        .filter((entry) => configuredIds === null || configuredIds.has(entry.instanceId))
        .map((entry) => [entry.instanceId, entry]),
    );
    for (const provider of environment.serverProviders ?? []) {
      if (entries.has(provider.instanceId)) continue;
      entries.set(provider.instanceId, {
        instanceId: provider.instanceId,
        driver: provider.driver,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        availability: emptyAvailabilityForDriver(provider.driver),
      });
    }
    return [...entries.values()].map((entry) => {
      const provider = environment.serverProviders?.find(
        (candidate) => candidate.instanceId === entry.instanceId,
      );
      const instance = environment.providerInstances?.[entry.instanceId];
      return {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        instanceId: entry.instanceId,
        driver: entry.driver,
        displayName:
          entry.displayName ?? provider?.displayName ?? providerLimitSourceName(entry.driver),
        ...(provider?.accentColor ? { accentColor: provider.accentColor } : {}),
        ...(instance?.failoverGroup ? { failoverGroup: instance.failoverGroup } : {}),
        enabled: provider?.enabled === true,
        authenticated: provider?.auth.status === "authenticated",
        availabilityRefreshSupported: provider?.availabilityRefreshSupported === true,
        isRefreshing: environment.refreshingInstanceIds?.includes(entry.instanceId) === true,
        availability: entry.availability,
      } satisfies SubscriptionAvailabilitySource;
    });
  });
}

const epochMillis = (isoDateTime: string | undefined): number | null => {
  if (!isoDateTime) return null;
  const value = Option.getOrNull(DateTime.make(isoDateTime));
  return value === null ? null : DateTime.toEpochMillis(value);
};

const windowKey = (window: ProviderAvailabilityWindow): string =>
  `${window.kind}:${window.scope ?? ""}`;

const windowDismissalKey = (
  threadId: string,
  instanceId: string,
  window: ProviderAvailabilityWindow,
): string =>
  [
    threadId,
    instanceId,
    windowKey(window),
    window.resetsAt ?? `used:${Math.round(window.usedPercent)}`,
  ].join(" | ");

/**
 * The most urgent window at or above the threshold for the instance a thread is
 * bound to, or null when there is nothing honest to say.
 *
 * A window whose reset has already passed is skipped: its percentage describes
 * a window that is over, and showing it as pressure would be a claim the person
 * cannot act on.
 */
export function deriveThreadUsageWarning(input: {
  readonly threadId: string | null | undefined;
  readonly environmentId: string | null | undefined;
  readonly instanceId: string | null | undefined;
  readonly sources: readonly SubscriptionAvailabilitySource[];
  /** Dismissal keys this client has already been told to stop showing. */
  readonly dismissedKeys?: ReadonlySet<string> | undefined;
  readonly nowMs?: number | undefined;
}): ThreadUsageWarning | null {
  const { threadId, environmentId, instanceId } = input;
  if (!threadId || !instanceId) return null;
  const nowMs = input.nowMs ?? DateTime.toEpochMillis(DateTime.nowUnsafe());

  const source = input.sources.find(
    (candidate) =>
      candidate.instanceId === instanceId &&
      (!environmentId || candidate.environmentId === environmentId) &&
      candidate.enabled === true &&
      candidate.authenticated === true &&
      candidate.availability.source !== "unsupported",
  );
  if (!source) return null;
  if (source.availability.status === "unknown" || source.availability.stale !== undefined) {
    return null;
  }

  const threshold = USAGE_WARNING_THRESHOLD * 100;
  const candidates = source.availability.windows.filter((window) => {
    if (window.usedPercent < threshold) return false;
    const resetsAtMs = epochMillis(window.resetsAt);
    if (resetsAtMs !== null && resetsAtMs <= nowMs) return false;
    return !input.dismissedKeys?.has(windowDismissalKey(threadId, instanceId, window));
  });
  if (candidates.length === 0) return null;

  // Most spent first; between equals, the one resetting soonest is the one the
  // person is about to run into.
  const window = candidates.toSorted((left, right) => {
    if (left.usedPercent !== right.usedPercent) return right.usedPercent - left.usedPercent;
    const leftReset = epochMillis(left.resetsAt) ?? Number.POSITIVE_INFINITY;
    const rightReset = epochMillis(right.resetsAt) ?? Number.POSITIVE_INFINITY;
    if (leftReset !== rightReset) return leftReset - rightReset;
    return windowKey(left).localeCompare(windowKey(right));
  })[0]!;

  const dismissalKey = windowDismissalKey(threadId, instanceId, window);

  return {
    instanceId,
    driver: source.driver,
    accountName: source.availability.account?.displayName ?? source.displayName,
    windowLabel: subscriptionLimitWindowLabel(window),
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    dismissalKey,
  };
}

/**
 * The reset moment as a local wall-clock time, with the weekday when it does
 * not land on today. Absolute rather than a countdown: a fixed label stays true
 * without a repainting timer, and weekly windows reset days out.
 */
export function formatUsageWarningReset(
  resetsAt: string | null,
  options: { readonly nowMs?: number | undefined; readonly timeZone?: string | undefined } = {},
): string | null {
  const resetsAtMs = epochMillis(resetsAt ?? undefined);
  if (resetsAtMs === null) return null;
  const nowMs = options.nowMs ?? DateTime.toEpochMillis(DateTime.nowUnsafe());
  const timeZone = options.timeZone;
  const format = (epoch: number, intlOptions: Intl.DateTimeFormatOptions): string => {
    const dateTime = DateTime.makeUnsafe(epoch);
    return timeZone
      ? DateTime.format(dateTime, { ...intlOptions, timeZone })
      : DateTime.formatLocal(dateTime, intlOptions);
  };

  const dayOptions = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  const sameDay = format(nowMs, dayOptions) === format(resetsAtMs, dayOptions);
  return format(resetsAtMs, {
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { weekday: "short" }),
  });
}
