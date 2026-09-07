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
  if (!window.resetsAt) return "Reset not reported";
  const date = new Date(window.resetsAt);
  if (!Number.isFinite(date.getTime())) return "Reset not reported";
  const today = date.toDateString() === new Date().toDateString();
  return today
    ? `Resets today, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
    : `Resets ${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

export function QuotaBar({
  window,
  color,
  prominent = false,
  label: labelOverride,
  showRemaining = false,
}: {
  readonly window: ProviderAvailabilityWindow;
  readonly color: string;
  readonly prominent?: boolean;
  readonly label?: string;
  readonly showRemaining?: boolean;
}) {
  const label = labelOverride ?? subscriptionLimitWindowLabel(window);
  return (
    <div className="min-w-0 space-y-[9px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span
          className={prominent ? "text-3xl font-semibold tabular-nums" : "text-xs tabular-nums"}
        >
          {Math.round(window.usedPercent)}%{showRemaining ? " used" : ""}
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
      <div className="flex justify-between gap-2 text-xs leading-4 text-muted-foreground">
        <span>{resetLabel(window)}</span>
        {showRemaining && <span>{Math.max(0, Math.round(100 - window.usedPercent))}% left</span>}
      </div>
    </div>
  );
}

export function UsageQuotas({
  sources,
  driver,
  isPending,
  isRefreshing,
  onRefresh,
  connected = true,
  refreshFailed = false,
}: {
  readonly sources: readonly SubscriptionAvailabilitySource[];
  readonly driver: string;
  readonly connected?: boolean;
  readonly refreshFailed?: boolean;
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const limits = useMemo(() => deriveSubscriptionLimits(sources), [sources]);
  const canRefresh =
    connected &&
    sources.some(
      (source) =>
        source.enabled &&
        source.authenticated &&
        source.availabilityRefreshSupported &&
        source.availability.source !== "unsupported",
    );
  const refreshUnavailableReason = !connected
    ? "Environment offline. Reconnect to refresh limits."
    : isPending
      ? "Waiting for account status…"
      : driver === "opencode"
        ? "Balance refresh is not supported by this OpenCode connection. Refresh usage updates token and cost history."
        : driver === "grok"
          ? "Quota refresh is unavailable on this Grok connection. Check its CLI version and sign-in status."
          : "Manual quota refresh is unavailable. Check this account’s connection, installation and sign-in status.";

  return (
    <section
      className="flex h-[286px] flex-col gap-5 overflow-y-auto rounded-[10px] border border-border bg-muted/30 p-5"
      aria-label="Usage limits"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] leading-[18px] font-semibold">Usage limits</h2>
          <span className="text-xs text-muted-foreground">
            {isPending || isRefreshing
              ? "Checking…"
              : !connected
                ? "Offline"
                : refreshFailed ||
                    limits.some((limit) => limit.isStale || limit.isCurrentAvailabilityUnknown)
                  ? "Last known"
                  : limits.some((limit) => limit.availability.windows.length)
                    ? "Ready"
                    : "Unavailable"}
          </span>
        </div>
        <UsageRefreshButton
          label="Refresh limits"
          confirmed={
            !refreshFailed &&
            connected &&
            sources.length > 0 &&
            sources.every(
              (source) =>
                source.availability.source === "unsupported" ||
                (source.availability.status !== "unknown" && !source.availability.stale),
            )
          }
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
        <div
          role="status"
          aria-label="Loading limits"
          className={
            driver === "codex"
              ? "grid flex-1 grid-cols-2 gap-9"
              : "grid flex-1 grid-cols-[1fr_2fr] gap-7"
          }
        >
          <div className="space-y-4">
            <QuotaSkeleton width="100px" />
            <QuotaSkeleton width="100px" height={44} />
            <QuotaSkeleton width="100%" />
          </div>
          <div className="space-y-7">
            <QuotaSkeleton width="100%" />
            <QuotaSkeleton width="100%" />
            <QuotaSkeleton width="100%" />
          </div>
        </div>
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
            {windows.length && kind === "codex" ? (
              <div className="grid grid-cols-1 gap-9 sm:grid-cols-2">
                {windows.map((window) => {
                  const spark = /spark/i.test(`${window.label} ${window.scope}`);
                  return (
                    <div key={`${window.kind}:${window.scope ?? ""}`} className="space-y-[9px]">
                      <QuotaBar
                        window={window}
                        color={spark ? "#0284C7" : color}
                        label={
                          spark
                            ? "Spark"
                            : window.kind === "primary"
                              ? "Codex usage"
                              : subscriptionLimitWindowLabel(window)
                        }
                        showRemaining
                      />
                      {spark && (
                        <p className="text-xs leading-4 text-muted-foreground">
                          Separate allowance for Codex-Spark
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : windows.length ? (
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

const NO_PENDING_ENVIRONMENTS: readonly string[] = [];

/** Informational rollover. Known rows retain their geometry while each reading settles. */
export function UsageQuotaSummary({
  sources,
  accounts,
  pendingEnvironmentIds = NO_PENDING_ENVIRONMENTS,
  refreshing = false,
}: {
  readonly sources: readonly SubscriptionAvailabilitySource[];
  readonly accounts: readonly UsageAccount[];
  readonly pendingEnvironmentIds?: readonly string[];
  readonly refreshing?: boolean;
}) {
  const rows = useMemo(
    () =>
      accounts.map((account) => ({
        account,
        reading: deriveSubscriptionLimits(
          sources.filter((source) =>
            account.memberships.some(
              (member) =>
                member.environmentId === source.environmentId &&
                member.provider.instanceId === source.instanceId,
            ),
          ),
        )[0],
      })),
    [accounts, sources],
  );
  const checking = refreshing || pendingEnvironmentIds.length > 0;
  return (
    <div
      className="w-[318px] text-left text-foreground font-normal"
      aria-label="Usage limits"
      aria-busy={checking}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex flex-col gap-[3px]">
          <div className="text-sm leading-5 font-semibold">Usage limits</div>
          <div className="text-[11px] leading-4 text-muted-foreground">
            {checking ? "Checking usage…" : "Percent used · last reported"}
          </div>
        </div>
        <span className="text-xs leading-[18px] text-muted-foreground">All environments</span>
      </div>
      {rows.map(({ account, reading }) => {
        const kind = usageProviderKind(account.driver);
        const { mark: Mark, color } = PROVIDER_PRESENTATION[kind];
        const availability = reading?.availability;
        const unknown =
          reading?.isStale || reading?.isCurrentAvailabilityUnknown || availability?.stale;
        const main = availability && lastKnownUsageWindow(kind, availability);
        const pending =
          !main &&
          account.memberships.some((member) =>
            pendingEnvironmentIds.includes(member.environmentId),
          );
        const blocked =
          availability && !unknown ? blockedSessionWindow(kind, availability) : undefined;
        const spark =
          kind === "codex"
            ? availability?.windows.find((window) =>
                /spark/i.test(`${window.scope} ${window.label}`),
              )
            : undefined;
        const session =
          kind === "claude"
            ? availability?.windows.find((window) => window.kind === "session" && !window.scope)
            : undefined;
        const hasBars = !blocked && (main || (pending && (kind === "codex" || kind === "claude")));
        return (
          <div
            key={account.key}
            className="flex flex-col gap-[5px] border-b border-border/50 px-3 py-2 last:border-b-0"
            style={{ minHeight: kind === "codex" || kind === "claude" ? 85 : 56 }}
          >
            <div className="flex items-center gap-2">
              <Mark className="size-[18px] shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium">
                {account.name}
              </span>
              <span className="flex w-9 shrink-0 justify-end text-[13px] leading-[18px] tabular-nums">
                {pending ? (
                  <QuotaSkeleton width="36px" height={18} />
                ) : blocked ? null : main ? (
                  `${Math.round(main.usedPercent)}%`
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div className="flex flex-col gap-1 pl-[26px] text-[11px] leading-4 text-muted-foreground">
              {blocked ? (
                <span className="text-destructive">
                  Session limit reached · {resetLabel(blocked)}
                </span>
              ) : hasBars ? (
                <>
                  <div className="h-[5px] overflow-hidden rounded-[3px] bg-border">
                    <div
                      className="h-full rounded-[3px]"
                      style={{
                        width: pending ? "0%" : `${main?.usedPercent ?? 0}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                  <div className="flex justify-between gap-1">
                    <span>
                      {kind === "codex"
                        ? "Main allowance"
                        : main?.kind === "weekly"
                          ? "Shared weekly"
                          : main
                            ? subscriptionLimitWindowLabel(main)
                            : "Shared weekly"}
                    </span>
                    {pending ? (
                      <QuotaSkeleton width="100px" />
                    ) : (
                      <span>
                        {unknown ? "Last known · needs refresh" : main && resetLabel(main)}
                      </span>
                    )}
                  </div>
                  {kind === "codex" && (spark || pending) && (
                    <div className="flex items-center gap-2">
                      <span className="w-[34px] shrink-0">Spark</span>
                      <span className="h-[3px] flex-1 rounded-[3px] bg-border">
                        <span
                          className="block h-full rounded-[3px] bg-sky-600"
                          style={{ width: pending ? "0%" : `${spark?.usedPercent ?? 0}%` }}
                        />
                      </span>
                      <span className="flex w-7 shrink-0 justify-end tabular-nums">
                        {pending ? (
                          <QuotaSkeleton width="28px" />
                        ) : (
                          `${Math.round(spark?.usedPercent ?? 0)}%`
                        )}
                      </span>
                    </div>
                  )}
                  {kind === "claude" && (
                    <div className="min-h-4">
                      {pending ? (
                        <QuotaSkeleton width="225px" />
                      ) : session && session.usedPercent >= 90 ? (
                        <span className={unknown ? "" : "text-amber-700 dark:text-amber-500"}>
                          Session {Math.round(session.usedPercent)}% used · {resetLabel(session)}
                        </span>
                      ) : null}
                    </div>
                  )}
                </>
              ) : pending ? (
                <QuotaSkeleton width="200px" />
              ) : (
                <span>
                  {unknown
                    ? "Last known · needs refresh"
                    : kind === "opencode"
                      ? "Pay as you go · balance not reported"
                      : "Limits unavailable"}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {rows.length === 0 &&
        (checking ? (
          <div role="status" aria-label="Loading accounts" className="space-y-6 p-3">
            {[0, 1, 2].map((key) => (
              <div key={key} className="space-y-2">
                <QuotaSkeleton width="160px" height={18} />
                <QuotaSkeleton width="100%" />
              </div>
            ))}
          </div>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">No provider readings available</p>
        ))}
    </div>
  );
}

function QuotaSkeleton({
  width,
  height = 16,
}: {
  readonly width: string;
  readonly height?: number;
}) {
  return (
    <span aria-hidden className="flex shrink-0 items-center" style={{ width, height }}>
      <span className="h-2 w-full rounded-[3px] bg-border" />
    </span>
  );
}
