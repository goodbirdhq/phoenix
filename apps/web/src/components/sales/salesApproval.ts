import { signApproval } from "@t3tools/client-runtime/sales/approval";
import type { SalesDeviceKey } from "@t3tools/client-runtime/sales/devices";
import { approveFailureText, approveRequestFailure } from "@t3tools/client-runtime/sales/outreach";
import { SALES_APPROVE_BATCH_LIMIT, type EnvironmentId } from "@t3tools/contracts";

import { readSalesFailure, salesEnvironment, useSalesDeviceGuard } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";

/** What happened to one approval, for the person who pressed. */
export interface ApproveOutcome {
  readonly activityId: string;
  readonly ok: boolean;
  readonly text: string;
  /** Set when the card moved on: re-show it, and never sign again without a new press. */
  readonly stale: boolean;
  /** Set when the request may have landed: the engine's answer was lost, so say "unknown". */
  readonly unknown: boolean;
}

/**
 * Signs each version on this device, one signature per draft, and sends them in batches of the
 * engine's limit. Every version handed in must be one this client verified against the text it
 * showed. Nothing is retried: a stale version comes back as `stale` for the page to re-show.
 * The device guard is checked again before each signature, and when a request fails in a way
 * that may still have landed, the queue is read again and the outcome reported as unknown.
 */
export function useApproveVersions(environmentId: EnvironmentId) {
  const approve = useAtomCommand(salesEnvironment.approve, { reportFailure: false });
  const refresh = useAtomCommand(salesEnvironment.refresh, { reportFailure: false });
  const blockedReason = useSalesDeviceGuard();
  return async (
    key: SalesDeviceKey,
    versions: ReadonlyArray<{ readonly activityId: string; readonly contentHash: string }>,
  ): Promise<ReadonlyArray<ApproveOutcome>> => {
    const outcomes: ApproveOutcome[] = [];
    let unknown = false;
    for (let start = 0; start < versions.length; start += SALES_APPROVE_BATCH_LIMIT) {
      const chunk = versions.slice(start, start + SALES_APPROVE_BATCH_LIMIT);
      const blocked = blockedReason(key.engine);
      if (blocked !== null) {
        for (const version of chunk) {
          outcomes.push({
            activityId: version.activityId,
            ok: false,
            text: blocked,
            stale: false,
            unknown: false,
          });
        }
        continue;
      }
      // Signed just before sending: the engine refuses a signature five minutes old.
      const items = await Promise.all(
        chunk.map((version) =>
          signApproval({
            privateKey: key.privateKey,
            deviceId: key.deviceId,
            activityId: version.activityId,
            contentHash: version.contentHash,
          }),
        ),
      );
      const result = await approve({ environmentId, input: { items } });
      if (result._tag !== "Success") {
        const failure = readSalesFailure(result);
        const outcome = approveRequestFailure(
          failure?.reason ?? null,
          failure?.description ?? null,
        );
        unknown ||= outcome.unknown;
        for (const version of chunk) {
          outcomes.push({
            activityId: version.activityId,
            ok: false,
            text: outcome.text,
            stale: false,
            unknown: outcome.unknown,
          });
        }
        continue;
      }
      for (const item of result.value.results) {
        outcomes.push(
          item.ok
            ? {
                activityId: item.card.activityId,
                ok: true,
                text: item.already
                  ? "Already approved."
                  : item.card.goes
                    ? `Approved. Goes ${item.card.goes}.`
                    : "Approved.",
                stale: false,
                unknown: false,
              }
            : {
                activityId: item.activityId,
                ok: false,
                text: approveFailureText(item.reason, item.message),
                stale: item.reason === "stale_hash",
                unknown: false,
              },
        );
      }
    }
    if (unknown) await refresh({ environmentId, input: {} });
    return outcomes;
  };
}
