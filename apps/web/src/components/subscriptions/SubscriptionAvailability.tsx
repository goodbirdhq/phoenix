import type { ProviderAvailability } from "@t3tools/contracts";
import {
  subscriptionLimitResetLabel as subscriptionResetLabel,
  subscriptionLimitWindowLabel as subscriptionWindowLabel,
} from "@t3tools/client-runtime/usage/subscription-availability";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

/** A live, readable reset label that never reports an already elapsed reset as remaining. */

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
