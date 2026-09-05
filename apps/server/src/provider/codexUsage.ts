import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ProviderAvailability } from "@t3tools/contracts";
import type { V2GetAccountRateLimitsResponse } from "effect-codex-app-server/schema";

/** Full account reads include every metered pool; the legacy pool is an alias, not extra quota. */
export function codexUsageFromResponse(
  response: V2GetAccountRateLimitsResponse,
  observedAt: string,
): ProviderAvailability {
  const pools = new Map(Object.entries(response.rateLimitsByLimitId ?? {}));
  const mainId = response.rateLimits.limitId ?? "codex";
  if (!pools.has(mainId)) pools.set(mainId, response.rateLimits);
  const windows = [...pools].flatMap(([id, pool]) =>
    (["primary", "secondary"] as const).flatMap((kind) => {
      const window = pool[kind];
      if (
        !window ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100
      )
        return [];
      const reset =
        window.resetsAt == null
          ? undefined
          : Option.getOrUndefined(
              Option.map(DateTime.make(window.resetsAt * 1000), DateTime.formatIso),
            );
      const scope = id === "codex" ? undefined : id;
      return [
        {
          kind,
          usedPercent: window.usedPercent,
          ...(scope
            ? {
                scope,
                label:
                  kind === "primary"
                    ? (pool.limitName ?? scope)
                    : `${pool.limitName ?? scope} · secondary`,
              }
            : {}),
          ...(reset ? { resetsAt: reset } : {}),
          ...(window.windowDurationMins != null &&
          Number.isInteger(window.windowDurationMins) &&
          window.windowDurationMins >= 0
            ? { windowDurationMins: window.windowDurationMins }
            : {}),
        },
      ];
    }),
  );
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
