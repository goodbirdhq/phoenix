import type { SalesConversation, SalesQueueItem } from "@t3tools/contracts";

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
