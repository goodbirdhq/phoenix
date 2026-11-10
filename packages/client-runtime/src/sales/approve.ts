import {
  SALES_APPROVE_BATCH_LIMIT,
  type SalesApproveItemResult,
  type SalesApproveResult,
  type SalesQueueItemDetail,
  type SalesSignedApproval,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import { checkSigning, type SalesDeviceKey, type SigningDevice } from "./devices.ts";
import {
  approveFailureText,
  approveRequestFailure,
  readSalesFailure,
  versionRefusalText,
} from "./failure.ts";
import { type VerifiedVersion, verifyReviewedVersion } from "./signing.ts";

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
 * engine's limit. Only verified versions can be passed, so nothing is signed that this client
 * did not hash from the text it showed. Nothing is retried: a stale version comes back as
 * `stale` for the page to re-show. `device` is read and checked (`checkSigning`) again before
 * each batch is signed, and when a request fails in a way that may still have landed,
 * `refresh` reads the queue again and the outcome is reported as unknown.
 */
export async function approveVersions(input: {
  readonly versions: ReadonlyArray<VerifiedVersion>;
  /** Sends one batch of signed approvals to the engine. */
  readonly approve: (
    items: ReadonlyArray<SalesSignedApproval>,
  ) => Promise<AtomCommandResult<SalesApproveResult, unknown>>;
  readonly refresh: () => Promise<unknown>;
  /** This device as it stands now. */
  readonly device: () => SigningDevice;
  /** Signs one version with this device's key. */
  readonly sign: (key: SalesDeviceKey, version: VerifiedVersion) => Promise<SalesSignedApproval>;
}): Promise<ReadonlyArray<ApproveOutcome>> {
  const outcomes: ApproveOutcome[] = [];
  const failAll = (chunk: ReadonlyArray<VerifiedVersion>, text: string, unknown: boolean) => {
    for (const version of chunk) {
      outcomes.push({ activityId: version.activityId, ok: false, text, stale: false, unknown });
    }
  };
  let unknown = false;
  for (let start = 0; start < input.versions.length; start += SALES_APPROVE_BATCH_LIMIT) {
    const chunk = input.versions.slice(start, start + SALES_APPROVE_BATCH_LIMIT);
    const signing = checkSigning(input.device());
    if (signing.refusal !== null) {
      failAll(chunk, signing.refusal.description, false);
      continue;
    }
    const { key } = signing;
    // Signed just before sending: the engine refuses a signature five minutes old.
    const items = await Promise.all(chunk.map((version) => input.sign(key, version)));
    const result = await input.approve(items);
    if (result._tag !== "Success") {
      const outcome = approveRequestFailure(readSalesFailure(result));
      unknown ||= outcome.unknown;
      failAll(chunk, outcome.text, outcome.unknown);
      continue;
    }
    outcomes.push(...result.value.results.map(itemOutcome));
  }
  if (unknown) await input.refresh();
  return outcomes;
}

const itemOutcome = (item: SalesApproveItemResult): ApproveOutcome =>
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
      };

/** One ticked draft in a batch's review step. Only `ready` is signed. */
export type ReviewedDraft =
  | { readonly status: "loading" }
  | { readonly status: "unreadable"; readonly text: string }
  | {
      readonly status: "ready";
      readonly detail: SalesQueueItemDetail;
      readonly version: VerifiedVersion;
    }
  | { readonly status: "refused"; readonly text: string };

/**
 * Reads a ticked draft again for the review step. It is `ready` to sign only when the hash this
 * client recomputes from the text the step shows equals the engine's and the one captured at
 * the tick (`verifyReviewedVersion`); otherwise it is `refused` and must be unticked.
 */
export async function reviewTickedDraft(
  read: () => Promise<AtomCommandResult<SalesQueueItemDetail, unknown>>,
  tickedHash: string,
): Promise<Exclude<ReviewedDraft, { readonly status: "loading" }>> {
  const result = await read();
  if (result._tag !== "Success") {
    return {
      status: "unreadable",
      text: readSalesFailure(result).description,
    };
  }
  const check = await verifyReviewedVersion(result.value, tickedHash);
  return check.ok
    ? { status: "ready", detail: result.value, version: check.version }
    : { status: "refused", text: versionRefusalText(check.reason, "review") };
}
