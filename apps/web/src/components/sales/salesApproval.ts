import { signApproval } from "@t3tools/client-runtime/sales/approval";
import type { SalesDeviceKey } from "@t3tools/client-runtime/sales/devices";
import { approveFailureText } from "@t3tools/client-runtime/sales/outreach";
import { SALES_APPROVE_BATCH_LIMIT, type EnvironmentId } from "@t3tools/contracts";

import { readSalesFailure, salesEnvironment } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";

/** What happened to one approval, for the person who pressed. */
export interface ApproveOutcome {
  readonly activityId: string;
  readonly ok: boolean;
  readonly text: string;
  /** Set when the card moved on: re-show it, and never sign again without a new press. */
  readonly stale: boolean;
}

/**
 * Signs each version on this device, one signature per draft, and sends them in batches of the
 * engine's limit. Every version handed in must be one this client verified against the text it
 * showed. Nothing is retried: a stale version comes back as `stale` for the page to re-show.
 */
export function useApproveVersions(environmentId: EnvironmentId) {
  const approve = useAtomCommand(salesEnvironment.approve, { reportFailure: false });
  return async (
    key: SalesDeviceKey,
    versions: ReadonlyArray<{ readonly activityId: string; readonly contentHash: string }>,
  ): Promise<ReadonlyArray<ApproveOutcome>> => {
    const outcomes: ApproveOutcome[] = [];
    for (let start = 0; start < versions.length; start += SALES_APPROVE_BATCH_LIMIT) {
      const chunk = versions.slice(start, start + SALES_APPROVE_BATCH_LIMIT);
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
        for (const version of chunk) {
          outcomes.push({
            activityId: version.activityId,
            ok: false,
            text: failure?.description ?? "The approval did not reach the engine.",
            stale: false,
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
              }
            : {
                activityId: item.activityId,
                ok: false,
                text: approveFailureText(item.reason, item.message),
                stale: item.reason === "stale_hash",
              },
        );
      }
    }
    return outcomes;
  };
}
