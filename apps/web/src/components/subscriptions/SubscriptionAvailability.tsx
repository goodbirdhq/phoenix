import type { ProviderAvailability, ProviderAvailabilityWindow } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";

export type SubscriptionAvailabilitySource = {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly availability: ProviderAvailability;
};

export type SubscriptionAccount = {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  /** The freshest native snapshot. Limits are never summed across sources. */
  readonly availability: ProviderAvailability;
  readonly environmentLabels: readonly string[];
  /** A native account subject is safe to merge between environments. */
  readonly verified: boolean;
  /** Two environments observed different native values for this account. */
  readonly hasDivergentSnapshots: boolean;
};

const availabilityObservedAt = (availability: ProviderAvailability): number => {
  if (!availability.observedAt) return Number.NEGATIVE_INFINITY;
  const value = new Date(availability.observedAt).getTime();
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
};

const snapshotSignature = (availability: ProviderAvailability): string =>
  availability.windows
    .map(
      (window) =>
        `${window.kind}:${window.scope ?? ""}:${window.usedPercent}:${window.resetsAt ?? ""}`,
    )
    .toSorted()
    .join("|");

/**
 * Turns per-environment observations into account cards without guessing that
 * two similarly named instances use the same subscription. Only a provider's
 * native, verified account id can cross the environment boundary.
 */
export function deriveSubscriptionAccounts(
  sources: readonly SubscriptionAvailabilitySource[],
): readonly SubscriptionAccount[] {
  const groups = new Map<string, SubscriptionAvailabilitySource[]>();
  for (const source of sources) {
    if (
      !source.enabled ||
      !source.authenticated ||
      source.availability.source === "unsupported" ||
      source.availability.windows.length === 0
    ) {
      continue;
    }
    const account = source.availability.account;
    const verified = account?.verification === "native_verified";
    const key = verified
      ? `${source.driver}:account:${account.id}`
      : `${source.environmentId}:instance:${source.instanceId}`;
    const group = groups.get(key);
    if (group) group.push(source);
    else groups.set(key, [source]);
  }

  return [...groups.entries()]
    .map(([id, members]) => {
      const newest = members.toSorted(
        (left, right) =>
          availabilityObservedAt(right.availability) - availabilityObservedAt(left.availability),
      )[0]!;
      const signatures = new Set(members.map((member) => snapshotSignature(member.availability)));
      const account = newest.availability.account;
      return {
        id,
        name: account?.displayName ?? newest.displayName,
        driver: newest.driver,
        availability: newest.availability,
        environmentLabels: [...new Set(members.map((member) => member.environmentLabel))],
        verified: account?.verification === "native_verified",
        hasDivergentSnapshots: signatures.size > 1,
      } satisfies SubscriptionAccount;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function subscriptionWindowLabel(window: ProviderAvailabilityWindow): string {
  if (window.label) return window.label;
  if (window.windowDurationMins === 300) return "5-hour";
  if (window.windowDurationMins === 10_080) return "Weekly";
  return window.kind.replaceAll("-", " ");
}

function resetLabel(window: ProviderAvailabilityWindow): string | null {
  if (!window.resetsAt) return null;
  const relative = formatRelativeTimeUntilLabel(window.resetsAt);
  return relative ? `resets ${relative}` : null;
}

function usageTone(usedPercent: number): string {
  if (usedPercent >= 100)
    return "[&::-moz-progress-bar]:bg-destructive [&::-webkit-progress-value]:bg-destructive";
  if (usedPercent >= 80)
    return "[&::-moz-progress-bar]:bg-warning [&::-webkit-progress-value]:bg-warning";
  return "[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary";
}

/** Small, legible native-quota bars shared by Settings and Usage. */
export function SubscriptionAvailabilityBars({
  availability,
  compact = false,
}: {
  readonly availability: ProviderAvailability;
  readonly compact?: boolean;
}) {
  if (availability.windows.length === 0) return null;
  return (
    <div className={cn("grid gap-2", compact ? "mt-2 max-w-xl" : "mt-4 gap-3")}>
      {availability.windows.map((window) => (
        <div key={`${window.kind}:${window.scope ?? ""}`} className="grid gap-1">
          <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium text-foreground">
              {subscriptionWindowLabel(window)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {window.usedPercent}% used
              {resetLabel(window) ? ` · ${resetLabel(window)}` : ""}
            </span>
          </div>
          <progress
            aria-label={`${subscriptionWindowLabel(window)} ${window.usedPercent}% used`}
            className={cn(
              "h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:rounded-full",
              usageTone(window.usedPercent),
            )}
            max={100}
            value={window.usedPercent}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Account-level usage section. This intentionally leaves out providers that
 * cannot publish a native quota, rather than filling the page with unknown
 * cards for every environment.
 */
export function SubscriptionAvailabilitySection({
  accounts,
}: {
  readonly accounts: readonly SubscriptionAccount[];
}) {
  if (accounts.length === 0) return null;
  return (
    <section className="border-y border-border py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Subscription limits</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Native provider limits for connected, authenticated accounts. Phoenix never adds quotas.
          </p>
        </div>
        <Badge variant="outline" className="text-muted-foreground">
          {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
        </Badge>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {accounts.map((account) => (
          <article
            key={account.id}
            className="rounded-xl border border-border bg-card p-4 shadow-xs"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-medium text-foreground">{account.name}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {account.environmentLabels.length === 1
                    ? account.environmentLabels[0]
                    : `${account.environmentLabels.length} connected environments`}
                  {!account.verified ? " · unverified instance" : ""}
                </p>
              </div>
              {account.availability.status === "limited" ? (
                <Badge variant="warning">Limit reached</Badge>
              ) : null}
            </div>
            <SubscriptionAvailabilityBars availability={account.availability} />
            {account.hasDivergentSnapshots ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Environments reported different snapshots; this card shows the newest one.
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
