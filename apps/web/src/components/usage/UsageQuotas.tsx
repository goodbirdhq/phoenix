import type { UsageAccount } from "@t3tools/client-runtime/usage/accounts";
import { useMemo } from "react";
import type { ProviderAvailabilityWindow } from "@t3tools/contracts";
import {
  deriveSubscriptionLimits,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
} from "@t3tools/client-runtime/usage/subscription-availability";
import { blockedSessionWindow, lastKnownUsageWindow } from "@t3tools/client-runtime/usage/quotas";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { usageProviderKind } from "./usageAccountPresentation";
import { UsageRefreshButton } from "./UsageRefreshButton";

function resetLabel(window: ProviderAvailabilityWindow): string {
  return window.resetsAt
    ? `Resets ${new Date(window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : "Reset not reported";
}

export function QuotaBar({
  window,
  color,
  prominent = false,
}: {
  readonly window: ProviderAvailabilityWindow;
  readonly color: string;
  readonly prominent?: boolean;
}) {
  const label = subscriptionLimitWindowLabel(window);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span
          className={prominent ? "text-3xl font-semibold tabular-nums" : "text-xs tabular-nums"}
        >
          {Math.round(window.usedPercent)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${window.usedPercent}%`,
            backgroundColor: window.usedPercent >= 100 ? "var(--destructive)" : color,
          }}
        />
      </div>
      <div className="text-xs text-muted-foreground">{resetLabel(window)}</div>
    </div>
  );
}

export function UsageQuotas({
  sources,
  driver,
  isPending,
  isRefreshing,
  onRefresh,
}: {
  readonly sources: readonly SubscriptionAvailabilitySource[];
  readonly driver: string;
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const limits = useMemo(() => deriveSubscriptionLimits(sources), [sources]);
  const canRefresh = sources.some(
    (source) => source.enabled && source.authenticated && source.availabilityRefreshSupported,
  );
  const refreshUnavailableReason = isPending
    ? "Waiting for account status…"
    : driver === "opencode"
      ? "Balance refresh is not supported by this OpenCode connection. Refresh usage updates token and cost history."
      : driver === "grok"
        ? "Grok quota refresh is not yet supported. Refresh usage updates token and cost history."
        : "Manual quota refresh is unavailable. Check this account’s connection, installation and sign-in status.";

  return (
    <section className="space-y-5 rounded-[10px] border bg-muted/30 p-5" aria-label="Usage limits">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Usage limits</h2>
        <UsageRefreshButton
          label="Refresh limits"
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          disabledReason={canRefresh ? undefined : refreshUnavailableReason}
        />
      </div>
      {!canRefresh && !isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {refreshUnavailableReason}
        </p>
      )}
      {isPending && limits.length === 0 && (
        <p className="text-sm text-muted-foreground">Loading limits…</p>
      )}
      {limits.map((limit) => {
        const kind = usageProviderKind(limit.driver);
        const windows = limit.availability.windows;
        const hero =
          kind === "claude"
            ? windows.find((window) => window.kind === "session" && !window.scope)
            : lastKnownUsageWindow(kind, limit.availability);
        const { color } = PROVIDER_PRESENTATION[kind];
        return (
          <div className="space-y-4" key={limit.key}>
            {limits.length > 1 && (
              <h3 className="text-sm font-medium">
                {limit.name} · {limit.environmentLabels.join(", ")}
              </h3>
            )}
            {(limit.isStale || limit.isCurrentAvailabilityUnknown || limit.availability.stale) && (
              <p role="status" className="text-xs text-muted-foreground">
                {limit.isStale
                  ? "Last known reading. Limits need refresh."
                  : "Current limits could not be confirmed."}
              </p>
            )}
            {windows.length ? (
              <div className="flex flex-col gap-7 sm:flex-row">
                {hero && (
                  <div className="sm:w-64 sm:shrink-0 sm:border-r sm:pr-7">
                    <QuotaBar window={hero} color={color} prominent />
                  </div>
                )}
                <div className="grid flex-1 gap-5">
                  {windows
                    .filter((window) => window !== hero)
                    .map((window) => (
                      <QuotaBar
                        key={`${window.kind}:${window.scope ?? ""}`}
                        window={window}
                        color={
                          /spark/i.test(`${window.label} ${window.scope}`)
                            ? "var(--color-sky-600, #0284c7)"
                            : color
                        }
                      />
                    ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {kind === "opencode"
                  ? "Pay as you go. Spending is shown as estimated API cost below; balance and budget are not reported."
                  : kind === "grok"
                    ? "Grok has not reported quota limits. Your token and cost history is available below."
                    : "No quota reading available for this account."}
              </p>
            )}
          </div>
        );
      })}
      {!isPending && limits.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {driver === "opencode"
            ? "Pay as you go. Balance and budget are not reported; API cost below is an estimate."
            : driver === "grok"
              ? "Grok has not reported quota limits. Token usage and estimated API cost are available below."
              : "No quota reading available. Check this account’s environment connection and sign-in status."}
        </p>
      )}
    </section>
  );
}

/** Informational hover content; no links or controls that a pointer cannot reach. */
export function UsageQuotaSummary({
  sources,
  accounts,
}: {
  readonly sources: readonly SubscriptionAvailabilitySource[];
  readonly accounts: readonly UsageAccount[];
}) {
  const limits = useMemo(
    () =>
      accounts.map((account) => {
        const reading = deriveSubscriptionLimits(
          sources.filter((source) =>
            account.memberships.some(
              (member) =>
                member.environmentId === source.environmentId &&
                member.provider.instanceId === source.instanceId,
            ),
          ),
        )[0];
        return {
          key: account.key,
          name: account.name,
          driver: String(account.driver),
          availability: reading?.availability ?? {
            status: "unknown" as const,
            source: "unsupported" as const,
            windows: [],
          },
          isStale: reading?.isStale ?? false,
          isCurrentAvailabilityUnknown: reading?.isCurrentAvailabilityUnknown ?? false,
        };
      }),
    [accounts, sources],
  );
  return (
    <div className="w-72 space-y-3 text-left font-normal text-foreground">
      <div className="border-b pb-2">
        <div className="text-sm font-semibold">Usage limits</div>
        <div className="text-xs text-muted-foreground">All environments · percent used</div>
      </div>
      {limits.map((limit) => {
        const kind = usageProviderKind(limit.driver);
        const { mark: Mark, color } = PROVIDER_PRESENTATION[kind];
        const unknown =
          limit.isStale || limit.isCurrentAvailabilityUnknown || !!limit.availability.stale;
        const blocked = unknown ? undefined : blockedSessionWindow(kind, limit.availability);
        const main = lastKnownUsageWindow(kind, limit.availability);
        const spark =
          kind === "codex" && !unknown
            ? limit.availability.windows.find((window) =>
                /spark/i.test(`${window.scope} ${window.label}`),
              )
            : undefined;
        return (
          <div className="space-y-1.5" key={limit.key}>
            <div className="flex items-center gap-2">
              <Mark className="size-4 shrink-0" />
              <span className="flex-1 truncate text-xs font-medium">{limit.name}</span>
              {!blocked && main && (
                <span className="text-xs tabular-nums">{Math.round(main.usedPercent)}%</span>
              )}
            </div>
            <div className="space-y-1 pl-6">
              {blocked ? (
                <p className="text-xs text-destructive">
                  Session limit reached · {resetLabel(blocked)}
                </p>
              ) : main ? (
                <>
                  <div className="h-1 overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full"
                      style={{ width: `${main.usedPercent}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {unknown
                      ? "Last known · needs refresh"
                      : `${subscriptionLimitWindowLabel(main)} · ${resetLabel(main)}`}
                  </div>
                  {spark && (
                    <div className="text-[11px] text-muted-foreground">
                      Spark · {Math.round(spark.usedPercent)}% used
                    </div>
                  )}
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {unknown
                    ? "Limits need refresh"
                    : kind === "opencode"
                      ? "Pay as you go · balance not reported"
                      : "Limits not reported"}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {limits.length === 0 && (
        <p className="text-xs text-muted-foreground">No provider readings available</p>
      )}
    </div>
  );
}
