import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderAvailability,
  type ProviderAvailabilityWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * A provider-limit observation paired with the connection that reported it.
 *
 * `enabled` and `authenticated` are optional because an availability response
 * can arrive before the separate provider-status projection. A concrete false
 * hides a row; missing status must not turn a reported limit into a disabled
 * or signed-out provider.
 */
export type SubscriptionAvailabilitySource = {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled?: boolean | undefined;
  readonly authenticated?: boolean | undefined;
  readonly availability: ProviderAvailability;
};

export type SubscriptionLimit = {
  /** Stable render key; not intended for display. */
  readonly key: string;
  /** Account name when the provider supplied one, otherwise the connection name. */
  readonly name: string;
  readonly availability: ProviderAvailability;
  /** Every environment that contributed this displayed reading. */
  readonly environmentLabels: readonly string[];
  /** Whether it was safe to combine observations across environments. */
  readonly isAccount: boolean;
  /** Two reports for the same verified account disagreed; show the newest one. */
  readonly hasDivergentSnapshots: boolean;
};

/** Presents an unknown extension driver without exposing its implementation slug. */
export function providerLimitSourceName(driver: string): string {
  const known = PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES];
  if (known) return known;
  return driver
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

const availabilityObservedAt = (availability: ProviderAvailability): number => {
  if (!availability.observedAt) return Number.NEGATIVE_INFINITY;
  const value = Option.getOrNull(DateTime.make(availability.observedAt));
  return value === null ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(value);
};

/** Includes presentation fields as well as values, so renamed pools are not hidden as duplicates. */
const snapshotSignature = (availability: ProviderAvailability): string =>
  availability.windows
    .map((window) =>
      [
        window.kind,
        window.label ?? "",
        window.scope ?? "",
        window.usedPercent,
        window.resetsAt ?? "",
        window.windowDurationMins ?? "",
      ].join(":"),
    )
    .toSorted()
    .join("|");

export function subscriptionLimitWindowLabel(window: ProviderAvailabilityWindow): string {
  if (window.label) return window.label;
  if (window.windowDurationMins === 300) return "5-hour";
  if (window.windowDurationMins === 10_080) return "Weekly";
  return window.kind.replaceAll("-", " ");
}

/** A readable reset label that never claims an elapsed reset is still pending. */
export function subscriptionLimitResetLabel(
  window: ProviderAvailabilityWindow,
  nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): string | null {
  if (!window.resetsAt) return null;
  const reset = Option.getOrNull(DateTime.make(window.resetsAt));
  if (reset === null) return null;
  const resetMs = DateTime.toEpochMillis(reset);
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "Ready to refresh";

  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  if (remainingMinutes === 1) return "Resets in 1m";
  if (remainingMinutes < 60) return `Resets in ${remainingMinutes}m`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  if (remainingHours < 24) return `Resets in ${remainingHours}h`;
  return `Resets in ${Math.ceil(remainingHours / 24)}d`;
}

/**
 * Groups only provider-reported account identities. When an integration does
 * not expose an identity, each configured provider remains a separate source;
 * matching names, email addresses, or provider kinds are never enough to
 * merge limits.
 */
export function deriveSubscriptionLimits(
  sources: readonly SubscriptionAvailabilitySource[],
): readonly SubscriptionLimit[] {
  const groups = new Map<string, SubscriptionAvailabilitySource[]>();
  for (const source of sources) {
    if (
      source.enabled === false ||
      source.authenticated === false ||
      source.availability.source === "unsupported" ||
      source.availability.windows.length === 0
    ) {
      continue;
    }
    const account = source.availability.account;
    const isAccount = account?.verification === "native_verified";
    const key = isAccount
      ? `${source.driver}:account:${account.id}`
      : `${source.environmentId}:instance:${source.instanceId}`;
    const group = groups.get(key);
    if (group) group.push(source);
    else groups.set(key, [source]);
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const newest = members.toSorted(
        (left, right) =>
          availabilityObservedAt(right.availability) - availabilityObservedAt(left.availability),
      )[0]!;
      const account = newest.availability.account;
      return {
        key,
        name: account?.displayName ?? newest.displayName,
        availability: newest.availability,
        environmentLabels: [...new Set(members.map((member) => member.environmentLabel))],
        isAccount: account?.verification === "native_verified",
        hasDivergentSnapshots:
          new Set(members.map((member) => snapshotSignature(member.availability))).size > 1,
      } satisfies SubscriptionLimit;
    })
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
    );
}
