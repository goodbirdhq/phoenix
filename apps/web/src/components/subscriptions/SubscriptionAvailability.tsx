import {
  deriveSubscriptionCapacity,
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionLimitResetLabel,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
  type SubscriptionCapacityGroup,
  type SubscriptionCapacityMember,
  type SubscriptionLimit,
} from "@t3tools/client-runtime/usage/subscription-availability";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId as EnvironmentIdValue,
  type ProviderAvailability,
  type ProviderInstanceId as ProviderInstanceIdValue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export {
  deriveSubscriptionLimits as deriveSubscriptionAccounts,
  providerLimitSourceName,
  type SubscriptionAvailabilitySource,
  type SubscriptionLimit as SubscriptionAccount,
};

export const subscriptionWindowLabel = subscriptionLimitWindowLabel;

type CapacityRefreshTarget = {
  readonly environmentId: EnvironmentIdValue;
  readonly instanceId: ProviderInstanceIdValue;
};

/** A live, readable reset label that never reports an already elapsed reset as remaining. */
export const subscriptionResetLabel = subscriptionLimitResetLabel;

function useResetClock(active: boolean): number {
  const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    if (!active) return;
    const delay = 60_000 - (now() % 60_000) + 25;
    const timeout = window.setTimeout(() => setNowMs(now()), delay);
    return () => window.clearTimeout(timeout);
  }, [active, nowMs]);
  return nowMs;
}

function usageTone(usedPercent: number): string {
  if (usedPercent >= 100)
    return "[&::-moz-progress-bar]:bg-destructive [&::-webkit-progress-value]:bg-destructive";
  if (usedPercent >= 80)
    return "[&::-moz-progress-bar]:bg-warning [&::-webkit-progress-value]:bg-warning";
  return "[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary";
}

/** Small, legible provider-limit bars shared by Settings and Usage. */
export function SubscriptionAvailabilityBars({
  availability,
  compact = false,
}: {
  readonly availability: ProviderAvailability;
  readonly compact?: boolean;
}) {
  const nowMs = useResetClock(availability.windows.some((window) => window.resetsAt !== undefined));
  if (availability.windows.length === 0) return null;
  return (
    <div className={cn("grid gap-2", compact ? "mt-2 max-w-xl" : "mt-4 gap-3")}>
      {availability.windows.map((window) => {
        const label = subscriptionWindowLabel(window);
        const reset = subscriptionResetLabel(window, nowMs);
        const progressLabel = `${label}: ${window.usedPercent}% used${reset ? `. ${reset}.` : ""}`;
        return (
          <div key={`${window.kind}:${window.scope ?? ""}`} className="grid gap-1">
            <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-medium text-foreground">{label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {window.usedPercent}% used
                {reset ? ` · ${reset}` : ""}
              </span>
            </div>
            <progress
              aria-label={progressLabel}
              aria-valuetext={progressLabel}
              className={cn(
                "h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full",
                usageTone(window.usedPercent),
              )}
              max={100}
              value={window.usedPercent}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Live Capacity uses Environment-local Failover groups and one selected presentation lens. */
export function SubscriptionAvailabilitySection({
  sources,
  isPending = false,
  hasError = false,
  onRefresh,
  isRefreshing = false,
}: {
  readonly sources: readonly SubscriptionAvailabilitySource[];
  readonly isPending?: boolean;
  readonly hasError?: boolean;
  /** Capacity refresh is independent from the historical-usage scan. */
  readonly onRefresh?: ((target?: CapacityRefreshTarget) => void) | undefined;
  readonly isRefreshing?: boolean;
}) {
  const [lens, setLens] = useState<"subscriptions" | "instances">("subscriptions");
  const capacity = useMemo(() => deriveSubscriptionCapacity(sources, lens), [lens, sources]);
  const isEmpty = capacity.groups.length === 0;
  const unsupportedUngroupedGroups = capacity.groups.filter(
    (group) =>
      group.isUngrouped &&
      group.members.every((member) => member.availability.source === "unsupported"),
  );
  const detailedGroups = capacity.groups.filter(
    (group) => !unsupportedUngroupedGroups.includes(group),
  );
  const hasObservedReading = capacity.groups.some((group) =>
    group.members.some((member) => member.availability.observedAt !== undefined),
  );
  return (
    <section className="flex flex-col gap-6" aria-labelledby="capacity-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="capacity-heading" className="text-sm font-medium text-foreground">
            Capacity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live subscription readiness and provider-native quota windows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex overflow-hidden rounded-md border border-border"
            role="group"
            aria-label="Capacity lens"
          >
            {(
              [
                { value: "subscriptions", label: "Subscriptions" },
                { value: "instances", label: "Instances" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={lens === option.value}
                onClick={() => setLens(option.value)}
                className={cn(
                  "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  lens === option.value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {onRefresh ? (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={isRefreshing}
              aria-label="Refresh capacity"
              aria-busy={isRefreshing || undefined}
              className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[10px] tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground disabled:cursor-default disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {isRefreshing ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
        </div>
      </div>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">
              {lens === "subscriptions" ? "Available subscriptions" : "Available instances"}
            </span>
            {isPending && !hasObservedReading ? (
              <div className="my-1.5 h-8 w-24 rounded-sm bg-muted" aria-label="Checking capacity" />
            ) : (
              <span className="text-4xl font-semibold text-foreground tabular-nums">
                {capacity.readinessCounts.available}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {lens === "subscriptions"
                ? "Distinct subscriptions ready for another Turn."
                : "Configured routing instances ready for another Turn."}
            </span>
          </div>

          {isEmpty && !isPending ? (
            <div className="text-sm leading-relaxed text-muted-foreground">
              <p>
                {hasError
                  ? "Capacity could not be checked for every connected Environment. Refresh capacity to try again."
                  : "No Provider instances are configured for Capacity."}
              </p>
              <a
                className="mt-2 inline-block text-foreground underline underline-offset-4"
                href="/settings/providers"
              >
                Manage Providers
              </a>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {capacity.providers.map((provider) => (
                <ProviderReadinessRow key={provider.driver} provider={provider} />
              ))}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-medium text-foreground">Quota windows</h3>
          {isPending && isEmpty ? (
            <CapacityQuotaSkeleton />
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {detailedGroups.map((group) => (
                <CapacityQuotaGroup
                  key={group.key}
                  group={group}
                  isPending={isPending}
                  onRefresh={onRefresh}
                />
              ))}
              {unsupportedUngroupedGroups.length > 0 ? (
                <UnsupportedLimitsSummary groups={unsupportedUngroupedGroups} />
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
        <CapacityMetric
          label="Ready"
          value={String(capacity.readinessCounts.available)}
          detail={lens}
        />
        <CapacityMetric
          label="Limited"
          value={String(capacity.readinessCounts.limited)}
          detail={lens}
        />
        <CapacityMetric
          label="Unknown"
          value={String(capacity.readinessCounts.unknown)}
          detail="unread or unreported"
        />
        <CapacityMetric
          label="Failover groups"
          value={String(capacity.failoverGroupCount)}
          detail="shown by Environment"
        />
        <CapacityMetric
          label="Environments"
          value={String(capacity.environmentCount)}
          detail={lens === "subscriptions" ? "represented" : `${capacity.instanceCount} instances`}
        />
      </section>

      {!isEmpty ? (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Breakdown</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Ungrouped {lens} never switch automatically.
            </p>
          </div>
          <div className="divide-y border-y border-border">
            {detailedGroups.map((group) => (
              <CapacityBreakdownGroup key={group.key} group={group} />
            ))}
            {unsupportedUngroupedGroups.length > 0 ? (
              <UnsupportedLimitsSummary groups={unsupportedUngroupedGroups} compact />
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function ProviderReadinessRow({
  provider,
}: {
  readonly provider: ReturnType<typeof deriveSubscriptionCapacity>["providers"][number];
}) {
  const counts = provider.readinessCounts;
  const share = provider.count === 0 ? 0 : (counts.available / provider.count) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">{providerLimitSourceName(provider.driver)}</span>
        <span className="text-foreground tabular-nums">
          {counts.available} of {provider.count} ready
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${share.toFixed(1)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">
        {counts.limited} limited · {counts.unknown} unknown
      </span>
    </div>
  );
}

function CapacityQuotaSkeleton() {
  return (
    <div className="divide-y divide-border border-y border-border">
      {[1, 2].map((row) => (
        <div
          key={row}
          className="grid gap-3 py-4 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)]"
        >
          <div className="flex flex-col gap-2">
            <div className="h-4 w-28 rounded-sm bg-muted" />
            <div className="h-3 w-36 rounded-sm bg-muted" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="h-3 w-24 rounded-sm bg-muted" />
            <div className="h-1.5 w-full rounded-full bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function CapacityQuotaGroup({
  group,
  isPending,
  onRefresh,
}: {
  readonly group: SubscriptionCapacityGroup;
  readonly isPending: boolean;
  readonly onRefresh?: ((target?: CapacityRefreshTarget) => void) | undefined;
}) {
  return (
    <section className="py-4 first:pt-0 last:pb-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h4 className="font-medium text-foreground">{group.label}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {providerLimitSourceName(group.driver)} ·{" "}
            {group.isUngrouped ? "No automatic failover" : "Failover group"} ·{" "}
            {groupReadinessSummary(group)}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">Environment: {group.environmentLabel}</span>
      </div>
      <div className="divide-y divide-border/60">
        {group.members.map((member) => (
          <CapacityQuotaRow
            key={member.key}
            member={member}
            isPending={isPending}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </section>
  );
}

function CapacityQuotaRow({
  member,
  isPending,
  onRefresh,
}: {
  readonly member: SubscriptionCapacityMember;
  readonly isPending: boolean;
  readonly onRefresh?: ((target?: CapacityRefreshTarget) => void) | undefined;
}) {
  const status = member.isRefreshing
    ? "Updating last reading"
    : member.readiness === "limited"
      ? "Limit reached"
      : member.readiness === "unknown"
        ? "Availability unknown"
        : "Ready";
  return (
    <article
      aria-busy={member.isRefreshing || undefined}
      className="grid gap-3 py-4 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)]"
    >
      <div className="flex min-w-0 gap-2.5">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make(member.driver)}
          displayName={member.name}
          accentColor={member.accentColor}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <h5 className="truncate font-medium text-foreground">{member.name}</h5>
          <p className="mt-0.5 text-xs text-muted-foreground">{status}</p>
        </div>
      </div>
      <div className="min-w-0">
        {isPending && member.availability.observedAt === undefined ? (
          <CapacityQuotaFieldsSkeleton />
        ) : member.availability.source === "unsupported" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">Limits not reported.</p>
        ) : (
          <SubscriptionAvailabilityBars availability={member.availability} compact />
        )}
        {member.availability.observedAt ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Observed {formatRelativeTimeLabel(member.availability.observedAt)}
          </p>
        ) : null}
        {member.availability.stale ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            This provider&apos;s previous quota reading has expired. Refresh capacity to check
            again.
          </p>
        ) : member.availability.source !== "unsupported" &&
          member.readiness === "unknown" &&
          !(isPending && member.availability.observedAt === undefined) ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            This provider could not confirm that these quota limits are current. Refresh capacity to
            check again.
          </p>
        ) : null}
        {onRefresh &&
        member.canRefresh &&
        member.readiness === "unknown" &&
        !member.isRefreshing ? (
          <button
            type="button"
            className="mt-2 cursor-pointer text-xs text-foreground underline underline-offset-4"
            onClick={() =>
              onRefresh({
                environmentId: EnvironmentId.make(member.environmentId),
                instanceId: ProviderInstanceId.make(member.instanceIds[0]!),
              })
            }
          >
            Retry this Provider
          </button>
        ) : member.readiness === "unknown" && !member.canRefresh ? (
          <a
            className="mt-2 inline-block text-xs text-foreground underline underline-offset-4"
            href="/settings/providers"
          >
            Manage Provider
          </a>
        ) : null}
      </div>
    </article>
  );
}

function UnsupportedLimitsSummary({
  groups,
  compact = false,
}: {
  readonly groups: readonly SubscriptionCapacityGroup[];
  readonly compact?: boolean;
}) {
  const byEnvironment = new Map<string, { label: string; providers: string[] }>();
  for (const group of groups) {
    const environment = byEnvironment.get(group.environmentId) ?? {
      label: group.environmentLabel,
      providers: [],
    };
    environment.providers.push(providerLimitSourceName(group.driver));
    byEnvironment.set(group.environmentId, environment);
  }

  return (
    <section className={cn("py-4 first:pt-0 last:pb-0", compact && "py-3")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h4 className={cn("font-medium text-foreground", compact && "text-xs")}>
            Limits not reported
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These ungrouped Providers never switch automatically.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {[...byEnvironment.values()].map((environment) => (
            <p key={environment.label}>
              {environment.providers.toSorted().join(", ")} · Environment: {environment.label}
            </p>
          ))}
          <a
            className="mt-1 inline-block text-foreground underline underline-offset-4"
            href="/settings/providers"
          >
            Manage Providers
          </a>
        </div>
      </div>
    </section>
  );
}

function CapacityQuotaFieldsSkeleton() {
  return (
    <div className="mt-2 flex flex-col gap-2" aria-label="Checking provider quota">
      <div className="h-3 w-24 rounded-sm bg-muted" />
      <div className="h-1.5 w-full rounded-full bg-muted" />
    </div>
  );
}

function CapacityMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-background px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function CapacityBreakdownRow({ member }: { readonly member: SubscriptionCapacityMember }) {
  return (
    <div className="grid gap-x-6 gap-y-1 py-3 text-sm sm:grid-cols-[minmax(10rem,1fr)_minmax(8rem,auto)_minmax(10rem,auto)] sm:items-center">
      <div className="min-w-0">
        <span className="font-medium text-foreground">{member.name}</span>
        {member.sharedSubscription ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Shares a subscription with {member.sharedInstanceIds.join(", ")}.
          </p>
        ) : null}
        {member.crossContextMemberships.length > 0 ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Also in{" "}
            {member.crossContextMemberships
              .map((membership) => `${membership.label} · ${membership.environmentLabel}`)
              .join(", ")}
            .
          </p>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground">
        {member.readiness === "limited"
          ? "Limit reached"
          : member.readiness === "unknown"
            ? "Availability unknown"
            : "Ready"}
      </span>
      <span className="text-xs text-muted-foreground">Environment: {member.environmentLabel}</span>
    </div>
  );
}

function CapacityBreakdownGroup({ group }: { readonly group: SubscriptionCapacityGroup }) {
  return (
    <section className="py-3 first:pt-0 last:pb-0">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h4 className="text-xs font-medium text-foreground">{group.label}</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {providerLimitSourceName(group.driver)} ·{" "}
            {group.isUngrouped ? "No automatic failover" : "Failover group"} ·{" "}
            {groupReadinessSummary(group)}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">Environment: {group.environmentLabel}</span>
      </div>
      <div className="divide-y divide-border/60">
        {group.members.map((member) => (
          <CapacityBreakdownRow key={member.key} member={member} />
        ))}
      </div>
    </section>
  );
}

function groupReadinessSummary(group: SubscriptionCapacityGroup): string {
  const counts = group.readinessCounts;
  const summary = [
    counts.available > 0 ? `${counts.available} ready` : null,
    counts.limited > 0 ? `${counts.limited} limited` : null,
    counts.unknown > 0 ? `${counts.unknown} unknown` : null,
  ].filter((part): part is string => part !== null);
  return summary.length > 0 ? summary.join(" · ") : "No subscriptions";
}
