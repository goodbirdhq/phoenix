import type { SalesMailbox, SalesMailboxList } from "@t3tools/contracts";

/** The engine's health check calls a mailbox behind after three hours without a full read. */
const STALE_SYNC_MS = 3 * 60 * 60 * 1000;

export interface SalesMailboxState {
  /** Inbound sync has not read its whole window for a while, or ever: new mail is not read.
      Never set for a retired mailbox. */
  readonly syncStale: boolean;
  /** Resting after its last send; no cold email before this. Null once the rest is over. */
  readonly restingUntil: string | null;
  /** Its next known send: the later of its rest and its earliest due slot. */
  readonly nextSendAt: string | null;
  /** One more hard bounce and the engine benches it. */
  readonly nearBench: boolean;
}

const later = (left: string, right: string | null) =>
  right !== null && Date.parse(right) > Date.parse(left) ? right : left;

/** What a mailbox row says beyond its raw counts, as of `now`. */
export function mailboxState(
  mailbox: SalesMailbox,
  bounceRule: SalesMailboxList["bounceRule"],
  now: number,
): SalesMailboxState {
  const synced = mailbox.lastSyncedAt === null ? Number.NaN : Date.parse(mailbox.lastSyncedAt);
  const resting =
    mailbox.restUntil !== null && Date.parse(mailbox.restUntil) > now ? mailbox.restUntil : null;
  return {
    syncStale:
      mailbox.status !== "retired" && (Number.isNaN(synced) || now - synced > STALE_SYNC_MS),
    restingUntil: resting,
    nextSendAt: mailbox.nextSlotAt === null ? null : later(mailbox.nextSlotAt, resting),
    nearBench:
      mailbox.status === "active" &&
      bounceRule.threshold > 0 &&
      mailbox.hardBouncesInWindow >= bounceRule.threshold - 1,
  };
}

const STATUS_ORDER = ["active", "warming", "benched", "retired"];

/** `8 active, 1 benched`: the pool by status, in the order mailboxes move through. */
export function poolLine(items: ReadonlyArray<SalesMailbox>): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const rank = (status: string) => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  const parts = [...counts.entries()]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([status, count]) => `${count} ${status}`);
  return parts.length === 0 ? "No mailboxes" : parts.join(", ");
}

/** The health message's lines as plain text: the engine escapes `&`, `<` and `>` for Slack. */
export function healthLines(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) =>
      line.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim(),
    )
    .filter((line) => line.length > 0);
}
