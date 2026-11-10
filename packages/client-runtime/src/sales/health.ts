import type { SalesMailbox, SalesMailboxList } from "@t3tools/contracts";

import { salesTime } from "./time.ts";

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

/** A mailbox's status in the order mailboxes move through, with its label and badge tone. */
const STATUSES = [
  { status: "active", label: "Active", tone: null },
  { status: "warming", label: "Warming up", tone: "info" },
  { status: "benched", label: "Benched", tone: "warning" },
  { status: "retired", label: "Retired", tone: "outline" },
] as const;

export type SalesMailboxTone = "info" | "warning" | "outline";

const statusEntry = (status: string) => STATUSES.find((entry) => entry.status === status);

/** A status as people read it; one this build does not know reads as the engine's word. */
export const mailboxStatusLabel = (status: string) => statusEntry(status)?.label ?? status;

/** How a status badge looks; null for `active`, the normal case, which needs no badge. */
export const mailboxStatusTone = (status: string): SalesMailboxTone | null => {
  const entry = statusEntry(status);
  return entry === undefined ? "outline" : entry.tone;
};

/** `8 active, 1 benched`: the pool by status, in the order mailboxes move through. */
export function poolLine(items: ReadonlyArray<SalesMailbox>): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const rank = (status: string) => {
    const index = STATUSES.findIndex((entry) => entry.status === status);
    return index === -1 ? STATUSES.length : index;
  };
  const parts = [...counts.entries()]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([status, count]) => `${count} ${mailboxStatusLabel(status).toLowerCase()}`);
  return parts.length === 0 ? "No mailboxes" : parts.join(", ");
}

/**
 * A mailbox row's line of facts: cold sends against its cap, replies and bounces, and its rest
 * or next send as of `now`.
 */
export function mailboxFacts(
  mailbox: SalesMailbox,
  bounceRule: SalesMailboxList["bounceRule"],
  now: number,
): string {
  const state = mailboxState(mailbox, bounceRule, now);
  const at = (iso: string | null) => salesTime(iso, now)?.local ?? null;
  return [
    `${mailbox.coldSentToday} of ${mailbox.dailyCap} cold today`,
    mailbox.repliesSentToday > 0 ? `${mailbox.repliesSentToday} replies` : null,
    mailbox.bouncesToday > 0 ? `${mailbox.bouncesToday} bounced today` : null,
    mailbox.hardBouncesInWindow > 0
      ? `${mailbox.hardBouncesInWindow} of ${bounceRule.threshold} hard bounces before it is benched`
      : null,
    state.restingUntil
      ? `Resting until ${at(state.restingUntil)}`
      : state.nextSendAt
        ? `Next send ${at(state.nextSendAt)}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A Slack mrkdwn token as plain text: a link reads as its label (or its URL), a mention as its
 * name, and a special mention such as `<!here>` as `@here`.
 */
const plainToken = (_token: string, target: string, label: string | undefined) => {
  if (target.startsWith("#") || target.startsWith("@"))
    return target[0] + (label ?? target.slice(1));
  if (target.startsWith("!")) return label ?? `@${target.slice(1)}`;
  return label ?? target;
};

/**
 * The engine's health message as plain lines. It is Slack mrkdwn: real `<…>` tokens are links or
 * mentions, and text from anywhere else has `&`, `<` and `>` escaped. Bullets go, since the lines
 * are listed anyway.
 */
export function healthLines(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/<([^<>|]+)(?:\|([^<>]*))?>/gu, plainToken)
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
        .replace(/^\s*[-•]\s+/u, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}
