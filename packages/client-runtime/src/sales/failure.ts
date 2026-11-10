import {
  SalesActionError,
  type SalesActionFailureReason,
  type SalesApproveFailureReason,
  type SalesFailureOrigin,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type AtomCommandResult, squashAtomCommandFailure } from "../state/runtime.ts";

/** What to tell the person when a sales request fails, on every client. */

export interface SalesFailureText {
  readonly title: string;
  readonly description: string;
  /** The card moved on: read it again before anything else. */
  readonly reread: boolean;
}

/** What to tell the person when a sales request fails. `message` is the server's detail. */
function salesFailureText(reason: SalesActionFailureReason, message: string): SalesFailureText {
  const text = (title: string, description = message, reread = false) => ({
    title,
    description,
    reread,
  });
  switch (reason) {
    case "not-configured":
      return text("Not set up");
    case "api-off":
    case "actions-off":
      return text("The engine has this turned off");
    case "unauthorised":
      return text("The engine refused the token");
    case "unreachable":
      return text("Can't reach the sales engine");
    case "budget":
      return text("The engine ran out of requests", message, true);
    case "failed":
      return text("The sales engine sent an error");
    case "bad_request":
      return text("The engine refused the request");
    case "bad_key":
      return text("The engine refused this device's key");
    case "device_exists":
      return text("That device id is taken", "Enrol again to make a new key and id.");
    case "too_many_pending":
      return text(
        "Too many devices wait for approval",
        "Approve or reject the waiting enrolments in Slack first.",
      );
    case "slack_failed":
      return text("The Slack card did not post", "Nothing was stored. Try again.");
    case "not_found":
      return text("The engine has no such draft", message, true);
    case "not_revocable":
      return text("This device is already rejected or revoked");
    case "not_open":
      return text("This draft is closed", "It was sent, discarded or withdrawn.", true);
    case "not_approved":
      return text("This draft is not approved", message, true);
    case "stale_hash":
      return text(
        "This draft changed",
        "It changed since you read it. Here is the new version; nothing was saved.",
        true,
      );
    case "changed_in_notion":
      return text(
        "Someone changed this draft in Notion",
        "Nothing was saved. The card catches up within five minutes; read it again then.",
        true,
      );
    case "row_gone":
      return text("The Notion row is gone", message, true);
    case "notion_failed":
      return text("Notion refused the write", "Nothing changed. Try again.", true);
    case "empty_body":
      return text("The body is empty", "Write something before saving.");
    case "body_too_long":
      return text("The body is too long", "Keep it under 3,000 characters.");
    case "subject_required":
      return text("A new thread needs a subject");
    case "subject_not_editable":
      return text("This draft's subject is its thread's", "Only the body can change.");
    case "no-agents-project":
      return text("Choose the sales agents project", message);
    case "agents-project-missing":
      return text("The sales agents project is gone", message);
    case "no-target":
      return text("Nothing to dispatch against");
    case "dispatch-failed":
      return text("Could not start the run");
    case "other":
      return text("The engine refused that");
  }
}

const isSalesActionError = Schema.is(SalesActionError);

export interface SalesFailure extends SalesFailureText {
  /** Who refused, or null when the request failed outside Sales. */
  readonly origin: SalesFailureOrigin | null;
  /** The typed reason, or null when the request failed outside Sales. */
  readonly reason: SalesActionFailureReason | null;
  /** The card's version now, when the engine said it moved on. */
  readonly currentHash: string | null;
  /** The card's state, when the failure names one (`discarded` after a failed reply redraft). */
  readonly state: string | null;
}

/** A failed sales command as the person should read it; null for a success. */
export function readSalesFailure(result: AtomCommandResult<unknown, unknown>): SalesFailure | null {
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  if (isSalesActionError(error)) {
    return {
      ...salesFailureText(error.reason, error.message),
      origin: error.origin,
      reason: error.reason,
      currentHash: error.currentHash,
      state: error.state,
    };
  }
  return {
    title: "Something went wrong",
    description: error instanceof Error ? error.message : "The request did not complete.",
    reread: false,
    origin: null,
    reason: null,
    currentHash: null,
    state: null,
  };
}

/**
 * What a person is told about each draft in an approve request that failed as a whole. Phoenix
 * refusing before it asked, or the engine refusing the request as such, approved nothing. For
 * the rest (no readable answer, an engine error, a request budget that ran out part-way) the
 * request may have landed, so the outcome is unknown and the page should read the queue again
 * rather than claim nothing was approved.
 */
export function approveRequestFailure(failure: SalesFailure): {
  readonly unknown: boolean;
  readonly text: string;
} {
  const refused = { unknown: false, text: failure.description };
  if (failure.origin === null || failure.origin === "transport") return UNKNOWN_APPROVE_OUTCOME;
  if (failure.origin === "phoenix") return refused;
  switch (failure.reason) {
    case "api-off":
    case "actions-off":
    case "unauthorised":
    case "bad_request":
      return refused;
    default:
      return UNKNOWN_APPROVE_OUTCOME;
  }
}

const UNKNOWN_APPROVE_OUTCOME = {
  unknown: true,
  text: "Phoenix could not tell whether the engine approved it. The queue has been read again; check its state before approving again.",
};

/** Why the engine turned one signed approval away, for the person who pressed. */
export function approveFailureText(reason: SalesApproveFailureReason, message: string): string {
  switch (reason) {
    case "device_not_active":
      return "This device is not active. Check its state in Settings › Integrations.";
    case "expired":
      return "The signature is too old, or this device's clock is off. Approve again.";
    case "bad_signature":
      return "The engine could not verify this device's signature.";
    case "replayed":
      return "That signature was already used. Approve again.";
    case "not_found":
      return "The engine has no such draft.";
    case "not_open":
      return "This draft is closed.";
    case "refused":
      return "The engine refuses to send it as it stands. An edit lifts that.";
    case "stale_hash":
      return "It changed since you read it. Read the new version and approve again.";
    case "bad_request":
    case "other":
      return message;
  }
}
