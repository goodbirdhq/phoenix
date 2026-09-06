import type { ProviderAvailability } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Cent = Schema.Struct({ val: Schema.optional(Schema.Number) });
const BillingResponse = Schema.Struct({
  config: Schema.NullOr(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
        }),
      ),
      monthlyLimit: Schema.optional(Schema.NullOr(Cent)),
      used: Schema.optional(Schema.NullOr(Cent)),
      billingPeriodEnd: Schema.optional(Schema.String),
    }),
  ),
});

const decodeBillingResponse = Schema.decodeUnknownSync(BillingResponse);

/** Grok ACP billing uses percentages; older CLIs report used/limit in USD cents. */
export function grokUsageFromResponse(response: unknown, observedAt: string): ProviderAvailability {
  const { config } = decodeBillingResponse(response);
  const percent =
    config?.creditUsagePercent ??
    (config?.monthlyLimit?.val && config.monthlyLimit.val > 0 && config.used != null
      ? ((config.used?.val ?? 0) / config.monthlyLimit.val) * 100
      : undefined);
  const end = config?.currentPeriod?.end ?? config?.billingPeriodEnd;
  const reset = end
    ? Option.getOrUndefined(Option.map(DateTime.make(end), DateTime.formatIso))
    : undefined;
  const kind =
    config?.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
      ? "weekly"
      : config?.currentPeriod?.type === "USAGE_PERIOD_TYPE_MONTHLY" ||
          (!config?.currentPeriod && config?.monthlyLimit)
        ? "monthly"
        : "primary";
  const windows =
    percent !== undefined && Number.isFinite(percent) && percent >= 0
      ? [
          {
            kind,
            label:
              kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Included credits",
            usedPercent: Math.min(100, percent),
            ...(reset ? { resetsAt: reset } : {}),
          },
        ]
      : [];
  return {
    source: "grok_acp",
    observedAt,
    status: windows.length ? (percent! >= 100 ? "limited" : "available") : "unknown",
    windows,
  };
}
