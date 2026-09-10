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
 * Status arrives through a separate projection. Limits are only shown after
 * that projection has positively confirmed that the provider is enabled and
 * authenticated; an unknown status must never read as signed in.
 */
export type SubscriptionAvailabilitySource = {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  /** The instance's own accent colour, so a card can be recognised at a glance. */
  readonly accentColor?: string | undefined;
  /** Optional Environment-local tag naming the instances that can fail over. */
  readonly failoverGroup?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly authenticated?: boolean | undefined;
  readonly availabilityRefreshSupported?: boolean | undefined;
  readonly isRefreshing?: boolean | undefined;
  readonly availability: ProviderAvailability;
};

export type SubscriptionLimit = {
  /** Stable render key; not intended for display. */
  readonly key: string;
  /** Account name when the provider supplied one, otherwise the connection name. */
  readonly name: string;
  /** Driver of the instances behind this card, for its provider mark. */
  readonly driver: string;
  /**
   * Configured instances behind this card, by display name.
   *
   * A card named by account says who the subscription belongs to but not which
   * instance in Settings it is, and with two accounts of one provider that is
   * exactly the question being asked. Empty when the card is already named
   * after its only instance.
   */
  readonly instanceLabels: readonly string[];
  /** Accent colour of the instance behind this card, when they agree on one. */
  readonly accentColor: string | undefined;
  readonly availability: ProviderAvailability;
  /** Every environment that contributed this displayed reading. */
  readonly environmentLabels: readonly string[];
  /** Whether it was safe to combine observations across environments. */
  readonly isAccount: boolean;
  /** Two reports for the same verified account disagreed; show the newest one. */
  readonly hasDivergentSnapshots: boolean;
  /** The provider retained identity metadata, but its quota windows expired. */
  readonly isStale: boolean;
  /** The provider could not confirm that the displayed reading is current. */
  readonly isCurrentAvailabilityUnknown: boolean;
};

/**
 * Separates an empty availability result from a not-yet-loaded provider
 * projection. The availability RPC deliberately omits enabled/auth facts, so
 * clients must wait for both reads before describing the result as final.
 */
export function subscriptionAvailabilityPresentationState(input: {
  readonly availabilityQueryPending: boolean;
  readonly availabilityQueryFailed: boolean;
  readonly providerProjectionReady: boolean;
}): { readonly isPending: boolean; readonly hasError: boolean } {
  return {
    isPending: input.availabilityQueryPending || !input.providerProjectionReady,
    hasError: input.availabilityQueryFailed,
  };
}

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
      source.enabled !== true ||
      source.authenticated !== true ||
      source.availability.source === "unsupported" ||
      (source.availability.windows.length === 0 &&
        (source.availability.status !== "unknown" || source.availability.observedAt === undefined))
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

  const limits = [...groups.entries()]
    .map(([key, members]) => {
      const newest = members.toSorted(
        (left, right) =>
          availabilityObservedAt(right.availability) - availabilityObservedAt(left.availability),
      )[0]!;
      const account = newest.availability.account;
      const name = account?.displayName ?? newest.displayName;
      const instanceLabels = [...new Set(members.map((member) => member.displayName))].toSorted();
      const accentColors = new Set(
        members.flatMap((member) => (member.accentColor ? [member.accentColor] : [])),
      );
      return {
        key,
        name,
        driver: newest.driver,
        // A card that already carries the instance's name does not need it
        // repeated as a tag.
        instanceLabels:
          instanceLabels.length === 1 && instanceLabels[0] === name ? [] : instanceLabels,
        accentColor: accentColors.size === 1 ? [...accentColors][0] : undefined,
        availability: newest.availability,
        environmentLabels: [...new Set(members.map((member) => member.environmentLabel))],
        isAccount: account?.verification === "native_verified",
        hasDivergentSnapshots:
          new Set(members.map((member) => snapshotSignature(member.availability))).size > 1,
        isStale:
          newest.availability.status === "unknown" && newest.availability.windows.length === 0,
        isCurrentAvailabilityUnknown: newest.availability.status === "unknown",
      } satisfies SubscriptionLimit;
    })
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
    );

  // A provider that reported real quota somewhere has already answered the
  // question these cards exist to answer. Its other cards carry no bars — only
  // a "could not read this one" notice — and repeating that per instance
  // crowds out the reading the person actually came for. Kept when nothing of
  // that provider reported anything, since then the notice is the only answer
  // available.
  const answeredDrivers = new Set(
    limits.flatMap((limit) => (limit.availability.windows.length > 0 ? [limit.driver] : [])),
  );
  return limits.filter(
    (limit) => limit.availability.windows.length > 0 || !answeredDrivers.has(limit.driver),
  );
}
