import {
  deriveSubscriptionLimits,
  providerLimitSourceName,
  subscriptionLimitResetLabel,
  subscriptionLimitWindowLabel,
  type SubscriptionAvailabilitySource,
  type SubscriptionLimit,
} from "@t3tools/client-runtime/usage/subscription-availability";
import type { ProviderAvailability } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";

export {
  deriveSubscriptionLimits as deriveSubscriptionAccounts,
  providerLimitSourceName,
  type SubscriptionAvailabilitySource,
  type SubscriptionLimit as SubscriptionAccount,
};

export const subscriptionWindowLabel = subscriptionLimitWindowLabel;

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

/** Provider limits grouped only where a provider reports an account identity. */
export function SubscriptionAvailabilitySection({
  accounts,
  isPending = false,
  hasError = false,
}: {
  readonly accounts: readonly SubscriptionLimit[];
  readonly isPending?: boolean;
  readonly hasError?: boolean;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">Subscription limits</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider-reported limits for connected providers. Phoenix combines readings only when a
          provider supplies a verified account identity.
        </p>
      </div>
      {accounts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {isPending
            ? "Checking connected providers for subscription limits…"
            : hasError
              ? "Subscription limits could not be checked for every connected environment. Refresh Usage to try again."
              : "No subscription limits are available. Some providers do not report limits to Phoenix, and others report them only after you sign in."}
        </p>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {accounts.map((account) => (
            <article
              key={account.key}
              className="rounded-lg border border-border bg-background p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-medium text-foreground">{account.name}</h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Reported by {account.environmentLabels.join(", ")}
                    {!account.isAccount
                      ? ". This provider does not share an account identity, so this reading stays separate."
                      : ""}
                  </p>
                </div>
                {account.availability.status === "limited" ? (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                    Limit reached
                  </span>
                ) : account.isCurrentAvailabilityUnknown ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    Availability unknown
                  </span>
                ) : null}
              </div>
              <SubscriptionAvailabilityBars availability={account.availability} />
              {account.isStale ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  This provider's previous quota reading has expired. Refresh Usage to check again.
                </p>
              ) : account.isCurrentAvailabilityUnknown ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  This provider could not confirm that these quota limits are current. Refresh Usage
                  to check again.
                </p>
              ) : null}
              {account.hasDivergentSnapshots ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Connected environments reported different readings; this card shows the latest
                  one.
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
