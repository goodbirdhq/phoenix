import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderAvailability,
  type ProviderAvailabilityAccount,
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

/** Inputs accepted by the shared Capacity presentation derivation. */
export type SubscriptionCapacitySource = SubscriptionAvailabilitySource;

export type SubscriptionCapacityLens = "subscriptions" | "instances";

export type SubscriptionCapacityReadiness = "available" | "limited" | "unknown";

export type SubscriptionCapacityReadinessCounts = Readonly<
  Record<SubscriptionCapacityReadiness, number>
>;

export type SubscriptionCapacityMembership = {
  readonly key: string;
  readonly label: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly driver: string;
  readonly failoverGroup: string | undefined;
};

/** One displayed subscription or routing target inside an Environment-local context. */
export type SubscriptionCapacityMember = {
  /** Stable key scoped to the Environment, Provider, and group context. */
  readonly key: string;
  /** The identity used to count capacity, independent of the selected lens. */
  readonly subscriptionKey: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly driver: string;
  readonly name: string;
  readonly instanceLabels: readonly string[];
  readonly instanceIds: readonly string[];
  readonly accentColor: string | undefined;
  readonly failoverGroup: string | undefined;
  readonly availability: ProviderAvailability;
  readonly account: ProviderAvailabilityAccount | undefined;
  readonly enabled: boolean | undefined;
  readonly authenticated: boolean | undefined;
  readonly readiness: SubscriptionCapacityReadiness;
  /** Alias for consumers that call the readiness badge a status. */
  readonly status: SubscriptionCapacityReadiness;
  /** True when this row represents one of multiple routing targets for an account. */
  readonly sharedSubscription: boolean;
  /** All instances sharing this member's verified account, including itself. */
  readonly sharedInstanceIds: readonly string[];
  /** Other Environment-local contexts in which this verified account appears. */
  readonly crossContextMemberships: readonly SubscriptionCapacityMembership[];
  /** Whether this configured instance/account can service a targeted quota probe. */
  readonly canRefresh: boolean;
  readonly refreshInstanceId: string | undefined;
  readonly isRefreshing: boolean;
};

export type SubscriptionCapacityProviderSummary = {
  readonly driver: string;
  readonly readinessCounts: SubscriptionCapacityReadinessCounts;
  readonly count: number;
};

/** Environment-local Failover group, or the synthetic Ungrouped context. */
export type SubscriptionCapacityGroup = {
  /** `${environmentId}:${driver}:${failoverGroup ?? ""}`. */
  readonly key: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly driver: string;
  readonly failoverGroup: string | undefined;
  readonly label: string;
  readonly isUngrouped: boolean;
  readonly members: readonly SubscriptionCapacityMember[];
  readonly readinessCounts: SubscriptionCapacityReadinessCounts;
  readonly counts: SubscriptionCapacityReadinessCounts;
  readonly subscriptionCount: number;
  readonly instanceCount: number;
};

export type SubscriptionCapacityPresentation = {
  readonly lens: SubscriptionCapacityLens;
  readonly groups: readonly SubscriptionCapacityGroup[];
  readonly providers: readonly SubscriptionCapacityProviderSummary[];
  readonly readinessCounts: SubscriptionCapacityReadinessCounts;
  readonly counts: SubscriptionCapacityReadinessCounts;
  readonly subscriptionCount: number;
  readonly instanceCount: number;
  readonly failoverGroupCount: number;
  readonly environmentCount: number;
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

const emptyReadinessCounts = (): {
  available: number;
  limited: number;
  unknown: number;
} => ({ available: 0, limited: 0, unknown: 0 });

const capacityReadiness = (source: SubscriptionCapacitySource): SubscriptionCapacityReadiness => {
  if (
    source.enabled !== true ||
    source.authenticated !== true ||
    source.availability.source === "unsupported" ||
    source.availability.stale !== undefined
  ) {
    return "unknown";
  }
  return source.availability.status;
};

const capacityGroupKey = (source: SubscriptionCapacitySource): string =>
  `${source.environmentId}:${source.driver}:${source.failoverGroup ?? ""}`;

const accountIdentity = (source: SubscriptionCapacitySource): string | undefined => {
  const account = source.availability.account;
  return account?.verification === "native_verified" ? account.id : undefined;
};

const capacitySubscriptionKey = (source: SubscriptionCapacitySource): string => {
  const account = accountIdentity(source);
  return account === undefined
    ? `${source.environmentId}:${source.driver}:instance:${source.instanceId}`
    : `${source.driver}:account:${account}`;
};

const mostRecentCapacitySource = (
  sources: readonly SubscriptionCapacitySource[],
): SubscriptionCapacitySource =>
  sources.reduce((newest, candidate) =>
    availabilityObservedAt(candidate.availability) > availabilityObservedAt(newest.availability)
      ? candidate
      : newest,
  );

const capacityStatus = (
  sources: readonly SubscriptionCapacitySource[],
): SubscriptionCapacityReadiness =>
  sources
    .map(capacityReadiness)
    .reduce<SubscriptionCapacityReadiness | undefined>(combineCapacityReadiness, undefined) ??
  "unknown";

/** A subscription is ready only when every contributing routing target is ready. */
function combineCapacityReadiness(
  current: SubscriptionCapacityReadiness | undefined,
  next: SubscriptionCapacityReadiness,
): SubscriptionCapacityReadiness {
  if (current === "limited" || next === "limited") return "limited";
  if (current === "unknown" || next === "unknown") return "unknown";
  return "available";
}

const sortCapacityStrings = (values: Iterable<string>): readonly string[] =>
  [...new Set(values)].toSorted((left, right) => left.localeCompare(right));

/**
 * Derive the shared Capacity model used by clients.
 *
 * Group identity is intentionally Environment-local: a tag alone never joins
 * two Environments, and the Provider driver remains part of the boundary.
 * The Subscriptions lens collapses only native-verified account identities;
 * the Instances lens retains every configured instance while carrying the
 * account's sharing metadata.
 */
export function deriveSubscriptionCapacity(
  sources: readonly SubscriptionCapacitySource[],
  lens: SubscriptionCapacityLens = "subscriptions",
): SubscriptionCapacityPresentation {
  type Context = {
    readonly key: string;
    readonly sources: SubscriptionCapacitySource[];
    readonly firstIndex: number;
  };

  const contexts = new Map<string, Context>();
  sources.forEach((source, index) => {
    const key = capacityGroupKey(source);
    const existing = contexts.get(key);
    if (existing) existing.sources.push(source);
    else contexts.set(key, { key, sources: [source], firstIndex: index });
  });

  // Build account membership independently from the selected lens. This lets
  // each row explain cross-context appearances without changing group counts.
  const accountContexts = new Map<string, Map<string, SubscriptionCapacityMembership>>();
  for (const context of contexts.values()) {
    for (const source of context.sources) {
      const account = accountIdentity(source);
      if (account === undefined) continue;
      const identity = `${source.driver}:account:${account}`;
      const memberships = accountContexts.get(identity) ?? new Map();
      memberships.set(context.key, {
        key: context.key,
        label: source.failoverGroup ?? "Ungrouped",
        environmentId: source.environmentId,
        environmentLabel: source.environmentLabel,
        driver: source.driver,
        failoverGroup: source.failoverGroup,
      });
      accountContexts.set(identity, memberships);
    }
  }

  const groupModels = [...contexts.values()]
    .toSorted((left, right) => {
      const leftSource = left.sources[0]!;
      const rightSource = right.sources[0]!;
      return (
        leftSource.environmentId.localeCompare(rightSource.environmentId) ||
        leftSource.environmentLabel.localeCompare(rightSource.environmentLabel) ||
        leftSource.driver.localeCompare(rightSource.driver) ||
        (leftSource.failoverGroup ?? "").localeCompare(rightSource.failoverGroup ?? "") ||
        left.firstIndex - right.firstIndex
      );
    })
    .map((context): SubscriptionCapacityGroup => {
      const representative = context.sources[0]!;
      const bySubscription = new Map<string, SubscriptionCapacitySource[]>();
      for (const source of context.sources) {
        const key = capacitySubscriptionKey(source);
        const members = bySubscription.get(key);
        if (members) members.push(source);
        else bySubscription.set(key, [source]);
      }

      const subscriptionRows = [...bySubscription.entries()]
        .map(([subscriptionKey, members]) => {
          const newest = mostRecentCapacitySource(members);
          const account = members
            .map((member) => member.availability.account)
            .find((candidate) => candidate?.verification === "native_verified");
          const readiness = capacityStatus(members);
          const instanceIds = sortCapacityStrings(members.map((member) => member.instanceId));
          const instanceLabels = sortCapacityStrings(members.map((member) => member.displayName));
          const accountMemberships = account
            ? accountContexts.get(`${newest.driver}:account:${account.id}`)
            : undefined;
          const crossContextMemberships = accountMemberships
            ? [...accountMemberships.values()]
                .filter((membership) => membership.key !== context.key)
                .toSorted((left, right) => left.key.localeCompare(right.key))
            : [];
          const refreshSource = members.find(
            (member) =>
              member.enabled === true &&
              member.authenticated === true &&
              member.availability.source !== "unsupported",
          );
          return {
            key: `${context.key}:${subscriptionKey}`,
            subscriptionKey,
            environmentId: newest.environmentId,
            environmentLabel: newest.environmentLabel,
            driver: newest.driver,
            name: account?.displayName ?? newest.displayName,
            instanceLabels,
            instanceIds,
            accentColor:
              new Set(members.flatMap((member) => (member.accentColor ? [member.accentColor] : [])))
                .size === 1
                ? members.find((member) => member.accentColor)?.accentColor
                : undefined,
            failoverGroup: newest.failoverGroup,
            availability: newest.availability,
            account,
            enabled: members.some((member) => member.enabled === true),
            authenticated: members.some((member) => member.authenticated === true),
            readiness,
            status: readiness,
            sharedSubscription: instanceIds.length > 1,
            sharedInstanceIds: instanceIds.length > 1 ? instanceIds : [],
            crossContextMemberships,
            canRefresh: refreshSource !== undefined,
            refreshInstanceId: refreshSource?.instanceId,
            isRefreshing: members.some((member) => member.isRefreshing === true),
          } satisfies SubscriptionCapacityMember;
        })
        .toSorted(
          (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
        );

      const members =
        lens === "subscriptions"
          ? subscriptionRows
          : context.sources
              .map((source): SubscriptionCapacityMember => {
                const subscription = subscriptionRows.find((row) =>
                  row.instanceIds.includes(source.instanceId),
                )!;
                const readiness = capacityReadiness(source);
                return {
                  ...subscription,
                  key: `${context.key}:instance:${source.instanceId}`,
                  subscriptionKey: subscription.subscriptionKey,
                  name: source.displayName,
                  instanceLabels: [source.displayName],
                  instanceIds: [source.instanceId],
                  accentColor: source.accentColor,
                  availability: source.availability,
                  account: source.availability.account,
                  enabled: source.enabled,
                  authenticated: source.authenticated,
                  readiness,
                  status: readiness,
                  sharedSubscription: subscription.instanceIds.length > 1,
                  sharedInstanceIds:
                    subscription.instanceIds.length > 1 ? subscription.instanceIds : [],
                  canRefresh:
                    source.enabled === true &&
                    source.authenticated === true &&
                    source.availability.source !== "unsupported",
                  refreshInstanceId:
                    source.enabled === true &&
                    source.authenticated === true &&
                    source.availability.source !== "unsupported"
                      ? source.instanceId
                      : undefined,
                  isRefreshing: source.isRefreshing === true,
                };
              })
              .toSorted(
                (left, right) =>
                  left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
              );

      const readinessCounts = emptyReadinessCounts();
      for (const member of subscriptionRows) readinessCounts[member.readiness] += 1;
      return {
        key: context.key,
        environmentId: representative.environmentId,
        environmentLabel: representative.environmentLabel,
        driver: representative.driver,
        failoverGroup: representative.failoverGroup,
        label: representative.failoverGroup ?? "Ungrouped",
        isUngrouped: representative.failoverGroup === undefined,
        members,
        readinessCounts,
        counts: readinessCounts,
        subscriptionCount: subscriptionRows.length,
        instanceCount: context.sources.length,
      };
    });

  const rootSubscriptions = new Map<string, SubscriptionCapacityReadiness>();
  for (const group of groupModels) {
    for (const member of group.members) {
      rootSubscriptions.set(
        member.subscriptionKey,
        combineCapacityReadiness(rootSubscriptions.get(member.subscriptionKey), member.readiness),
      );
    }
  }
  const readinessCounts = emptyReadinessCounts();
  for (const readiness of rootSubscriptions.values()) readinessCounts[readiness] += 1;

  const providerRows = new Map<string, Map<string, SubscriptionCapacityReadiness>>();
  for (const group of groupModels) {
    const rows = providerRows.get(group.driver) ?? new Map();
    for (const member of group.members) {
      rows.set(
        member.subscriptionKey,
        combineCapacityReadiness(rows.get(member.subscriptionKey), member.readiness),
      );
    }
    providerRows.set(group.driver, rows);
  }
  const providers = [...providerRows]
    .map(([driver, rows]): SubscriptionCapacityProviderSummary => {
      const counts = emptyReadinessCounts();
      for (const readiness of rows.values()) counts[readiness] += 1;
      return { driver, readinessCounts: counts, count: rows.size };
    })
    .toSorted(
      (left, right) =>
        providerLimitSourceName(left.driver).localeCompare(providerLimitSourceName(right.driver)) ||
        left.driver.localeCompare(right.driver),
    );

  return {
    lens,
    groups: groupModels,
    providers,
    readinessCounts,
    counts: readinessCounts,
    subscriptionCount: rootSubscriptions.size,
    instanceCount: sources.length,
    failoverGroupCount: groupModels.filter((group) => !group.isUngrouped).length,
    environmentCount: new Set(sources.map((source) => source.environmentId)).size,
  };
}
