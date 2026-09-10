import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ProviderAvailability, ProviderAvailabilityWindow } from "@t3tools/contracts";
import type { V2GetAccountRateLimitsResponse } from "effect-codex-app-server/schema";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** Shared by sparse notifications and full account reads; model-specific pools stay scoped. */
function poolWindows(value: unknown, poolId?: string): ProviderAvailabilityWindow[] {
  const pool = record(value);
  if (!pool) return [];
  const id = poolId ?? (typeof pool.limitId === "string" ? pool.limitId : "codex");
  const scope = id === "codex" ? undefined : id;
  const name = typeof pool.limitName === "string" ? pool.limitName : scope;
  return (["primary", "secondary"] as const).flatMap((kind) => {
    const window = record(pool[kind]);
    const usedPercent = window?.usedPercent;
    if (
      typeof usedPercent !== "number" ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100
    )
      return [];
    const reset =
      typeof window?.resetsAt === "number"
        ? Option.getOrUndefined(
            Option.map(DateTime.make(window.resetsAt * 1000), DateTime.formatIso),
          )
        : undefined;
    const duration = window?.windowDurationMins;
    return [
      {
        kind,
        usedPercent,
        ...(scope ? { scope, label: kind === "primary" ? name : `${name} · secondary` } : {}),
        ...(reset ? { resetsAt: reset } : {}),
        ...(typeof duration === "number" && Number.isInteger(duration) && duration >= 0
          ? { windowDurationMins: duration }
          : {}),
      },
    ];
  });
}

function availability(
  windows: ProviderAvailabilityWindow[],
  observedAt: string,
): ProviderAvailability {
  return {
    source: "codex_app_server",
    observedAt,
    status: windows.some((window) => window.usedPercent >= 100)
      ? "limited"
      : windows.length
        ? "available"
        : "unknown",
    windows,
  };
}

export function codexUsageFromSnapshot(
  snapshot: unknown,
  observedAt: string,
): ProviderAvailability {
  return availability(poolWindows(snapshot), observedAt);
}

/** Full reads include every pool; the legacy pool is an alias, not extra quota. */
export function codexUsageFromResponse(
  response: V2GetAccountRateLimitsResponse,
  observedAt: string,
): ProviderAvailability {
  const pools = new Map(Object.entries(response.rateLimitsByLimitId ?? {}));
  const mainId = response.rateLimits.limitId ?? "codex";
  if (!pools.has(mainId)) pools.set(mainId, response.rateLimits);
  return availability(
    [...pools].flatMap(([id, pool]) => poolWindows(pool, id)),
    observedAt,
  );
}
