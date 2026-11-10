import type {
  SalesActionFailureReason,
  SalesApproveFailureReason,
  SalesConversation,
  SalesQueueItem,
} from "@t3tools/contracts";

/** A list group of the Outreach page: one campaign's open cards, oldest first. */
export interface SalesQueueGroup {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<SalesQueueItem>;
}

/** Groups open cards by campaign in queue order (oldest card first); no campaign sorts last. */
export function groupQueue(items: ReadonlyArray<SalesQueueItem>): ReadonlyArray<SalesQueueGroup> {
  const groups = new Map<string, SalesQueueItem[]>();
  for (const item of items) {
    const key = item.campaign ?? "";
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === "" ? 1 : 0) - (right === "" ? 1 : 0))
    .map(([key, groupItems]) => ({ key, label: key || "No campaign", items: groupItems }));
}

/** The order the list shows, for J/K and batch selection. */
export const queueOrder = (groups: ReadonlyArray<SalesQueueGroup>) =>
  groups.flatMap((group) => group.items);

/**
 * The ticked rows a batch may take to its review step: still waiting, and still listed with the
 * hash captured when the person ticked them (`ticked` maps activity id to that hash). A row the
 * next poll swapped for a new version drops out, so a tick never carries over to content the
 * person has not looked at.
 */
export function tickedForReview(
  order: ReadonlyArray<SalesQueueItem>,
  ticked: ReadonlyMap<string, string>,
): ReadonlyArray<SalesQueueItem> {
  return order.filter(
    (item) =>
      item.state === "awaiting" &&
      ticked.get(item.activityId)?.toLowerCase() === item.contentHash.toLowerCase(),
  );
}

/**
 * Whether an open draft should be read again because the list now reports another version of
 * it. Only a change in the listed hash counts: a read that still disagrees with the list (the
 * list lags the engine, or the engine moved on again) must not trigger another read, or the two
 * would chase each other.
 */
export function listedVersionMoved(
  previousListed: string | null,
  listed: string | null,
  shown: string | null,
): boolean {
  if (listed === null || shown === null || listed === previousListed) return false;
  return listed.toLowerCase() !== shown.toLowerCase();
}

export function kindLabel(kind: string | null): string {
  switch (kind) {
    case "first":
      return "First touch";
    case "chase":
      return "Chase";
    case "revisit":
      return "Revisit";
    case "reply":
      return "Reply";
    default:
      return "Draft";
  }
}

/** A card's state as a short label. Unknown states read as their own word. */
export function stateLabel(state: string): string {
  switch (state) {
    case "awaiting":
      return "Waiting";
    case "approved":
      return "Approved";
    case "held":
      return "Held";
    case "refused":
      return "Refused";
    case "sent":
      return "Sent";
    case "discarded":
      return "Discarded";
    case "withdrawn":
      return "Withdrawn";
    case "failed":
      return "Failed";
    default:
      return state;
  }
}

/** What a person can do to a card in this state. */
export function cardActions(item: Pick<SalesQueueItem, "state" | "approval">) {
  const open = ["awaiting", "approved", "held", "refused"].includes(item.state);
  const approved = item.approval !== null;
  return {
    approve: item.state === "awaiting",
    unapprove: open && approved && item.approval?.by !== "route",
    edit: open,
    discard: open,
    redraft: open && !approved,
  };
}

export function intentLabel(intent: string | null | undefined): string {
  switch (intent) {
    case "interested":
      return "Interested";
    case "deferred":
      return "Later";
    case "declined":
      return "Declined";
    case "redirect":
      return "Redirect";
    case "ooo":
      return "Out of office";
    case "bounce":
      return "Bounce";
    case "unsubscribe":
      return "Unsubscribe";
    case null:
    case undefined:
      return "Unclassified";
    default:
      return "Other";
  }
}

/** Conversations that wait on an answer first, then newest reply first (the engine's order). */
export function sortConversations(
  items: ReadonlyArray<SalesConversation>,
): ReadonlyArray<SalesConversation> {
  return [...items].sort(
    (left, right) => Number(right.awaitingAnswer) - Number(left.awaitingAnswer),
  );
}

export interface SalesFailureText {
  readonly title: string;
  readonly description: string;
  /** The card moved on: read it again before anything else. */
  readonly reread: boolean;
}

/** What to tell the person when a sales request fails. `message` is the server's detail. */
export function salesFailureText(
  reason: SalesActionFailureReason,
  message: string,
): SalesFailureText {
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

/**
 * What a person is told about each draft in an approve request that failed as a whole. The
 * engine refused before approving anything for some reasons; for the rest (a timeout, a dropped
 * connection, an engine error, a request budget that ran out part-way) the request may have landed, so the outcome is unknown and the
 * page should read the queue again rather than claim nothing was approved.
 */
export function approveRequestFailure(
  reason: SalesActionFailureReason | null,
  description: string | null,
): { readonly unknown: boolean; readonly text: string } {
  switch (reason) {
    case "not-configured":
    case "api-off":
    case "actions-off":
    case "unauthorised":
    case "bad_request":
      return { unknown: false, text: description ?? "The engine refused the request." };
    default:
      return {
        unknown: true,
        text: "Phoenix could not tell whether the engine approved it. The queue has been read again; check its state before approving again.",
      };
  }
}

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
