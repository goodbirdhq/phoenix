import type { SalesSnapshot, SalesSummary } from "@t3tools/contracts";

/** The work areas of the Sales sidebar, in order. */
export const SALES_WORK_AREAS = [
  { key: "sourcing", label: "Sourcing" },
  { key: "outreach", label: "Outreach" },
  { key: "autopilot", label: "Autopilot" },
  { key: "todo", label: "To do" },
  { key: "conversations", label: "Conversations" },
] as const;
export type SalesWorkAreaKey = (typeof SALES_WORK_AREAS)[number]["key"];

export interface SalesHomeFigure {
  readonly label: string;
  readonly value: string;
}

export interface SalesHomeArea {
  readonly key: SalesWorkAreaKey;
  readonly label: string;
  /** Items in this area that wait on a person. Null when the engine says nothing about it. */
  readonly count: number | null;
  readonly status: string;
  readonly figures: ReadonlyArray<SalesHomeFigure>;
}

export interface SalesHome {
  readonly needsYou: number;
  readonly headline: string;
  readonly areas: ReadonlyArray<SalesHomeArea>;
  readonly health: { readonly ok: boolean; readonly line: string };
}

/** The Dispatcher pokes every five minutes; the engine calls one older than ten stopped. */
const STOPPED_POKE_AGE_SECONDS = 10 * 60;
const STOPPED_TICK_LATENESS_MS = 10 * 60 * 1000;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function outreach(summary: SalesSummary): SalesHomeArea {
  const { awaiting, approvedWaiting, held, refused } = summary.drafts;
  const status =
    awaiting.total > 0
      ? `${plural(awaiting.total, "draft")} ${awaiting.total === 1 ? "waits" : "wait"} for approval`
      : refused > 0
        ? `${plural(refused, "draft")} refused; an edit in Notion lifts it`
        : "Nothing waits for approval";
  return {
    key: "outreach",
    label: "Outreach",
    count: awaiting.total,
    status,
    figures: [
      { label: "Approved", value: String(approvedWaiting) },
      { label: "Held", value: String(held) },
      { label: "Refused", value: String(refused) },
    ],
  };
}

function autopilot(summary: SalesSummary): SalesHomeArea {
  const today = summary.autopilotToday;
  const going = today.sending + today.retrying;
  const status =
    today.failed > 0
      ? `${plural(today.failed, "send")} failed today`
      : today.sent + today.scheduled + going === 0
        ? "Nothing goes out today"
        : `${today.sent} sent, ${today.scheduled} scheduled today`;
  return {
    key: "autopilot",
    label: "Autopilot",
    // Refusals get a normal card, so Outreach already counts them.
    count: today.failed,
    status,
    figures: [
      { label: "Sent", value: String(today.sent) },
      { label: "Scheduled", value: String(today.scheduled) },
      { label: "Held", value: String(today.held) },
    ],
  };
}

function todo(summary: SalesSummary): SalesHomeArea {
  const { onSlack, pending, budget } = summary.linkedin;
  const status =
    onSlack > 0
      ? `${plural(onSlack, "LinkedIn task")} ready to do`
      : pending > 0
        ? `${plural(pending, "LinkedIn task")} not yet on a card`
        : "No LinkedIn tasks";
  return {
    key: "todo",
    label: "To do",
    count: onSlack,
    status,
    figures: [
      { label: "Ready", value: String(onSlack) },
      { label: "Pending", value: String(pending) },
      ...(budget.available !== null && budget.dailyLimit !== null
        ? [{ label: "Invites left", value: `${budget.available} of ${budget.dailyLimit}` }]
        : []),
    ],
  };
}

function conversations(summary: SalesSummary): SalesHomeArea {
  const awaiting = summary.replies.awaitingAnswer;
  return {
    key: "conversations",
    label: "Conversations",
    count: awaiting,
    status:
      awaiting > 0
        ? `${plural(awaiting, "reply", "replies")} ${awaiting === 1 ? "waits" : "wait"} for an answer`
        : "Every reply has an answer",
    figures: [
      { label: "Reply drafts", value: String(summary.drafts.awaiting.reply) },
      { label: "Replies sent today", value: String(summary.sendsToday.replies) },
    ],
  };
}

const SOURCING: SalesHomeArea = {
  key: "sourcing",
  label: "Sourcing",
  count: null,
  status: "Not in the engine's summary yet",
  figures: [],
};

function dispatcherProblem(summary: SalesSummary): string | null {
  const dispatcher = summary.dispatcher;
  if (dispatcher.paused === true) return "Dispatcher paused";
  if (dispatcher.pokeAgeSeconds !== null && dispatcher.pokeAgeSeconds > STOPPED_POKE_AGE_SECONDS) {
    return `Dispatcher looks stopped: last poke ${Math.round(dispatcher.pokeAgeSeconds / 60)} min ago`;
  }
  const generatedAt = Date.parse(summary.generatedAt);
  const nextTickAt =
    dispatcher.nextTickAt === null ? Number.NaN : Date.parse(dispatcher.nextTickAt);
  if (generatedAt - nextTickAt > STOPPED_TICK_LATENESS_MS) {
    return "Dispatcher looks stopped: its next tick is overdue";
  }
  if (dispatcher.lastPokeAt === null) return "Dispatcher has not reported yet";
  return null;
}

function health(summary: SalesSummary): SalesHome["health"] {
  const { mailboxes, sendsToday, needsALook } = summary;
  const problem = dispatcherProblem(summary);
  const parts = [
    ...(problem === null ? [] : [problem]),
    [
      plural(mailboxes.active, "mailbox", "mailboxes") + " active",
      ...(mailboxes.warming > 0 ? [`${mailboxes.warming} warming`] : []),
      ...(mailboxes.benched > 0 ? [`${mailboxes.benched} benched`] : []),
    ].join(", "),
    `${sendsToday.cold} of ${sendsToday.coldCap} cold sends today`,
    ...(needsALook.count > 0
      ? [`${needsALook.capped ? `${needsALook.count}+` : needsALook.count} need a look`]
      : []),
  ];
  return {
    ok: problem === null && mailboxes.benched === 0 && needsALook.count === 0,
    line: parts.join(" · "),
  };
}

/** What the Sales Home shows for one engine summary. */
export function buildSalesHome(summary: SalesSummary): SalesHome {
  const areas = [
    SOURCING,
    outreach(summary),
    autopilot(summary),
    todo(summary),
    conversations(summary),
  ];
  const needsYou = areas.reduce((total, area) => total + (area.count ?? 0), 0);
  return {
    needsYou,
    headline:
      needsYou === 0
        ? "Nothing needs you"
        : `${plural(needsYou, "thing")} ${needsYou === 1 ? "needs" : "need"} you`,
    areas,
    health: health(summary),
  };
}

export interface SalesStatusNotice {
  readonly title: string;
  readonly description: string;
  /** What the notice offers: fix the settings, or ask again. */
  readonly action: "settings" | "retry" | null;
}

/** What to say for a snapshot that is not a fresh summary. Null when it is. */
export function salesStatusNotice(snapshot: SalesSnapshot): SalesStatusNotice | null {
  const description = snapshot.message ?? "";
  switch (snapshot.status) {
    case "ready":
      return null;
    case "not-configured":
      return {
        title: "Sales is not set up",
        description: "Add the sales engine's URL and read token in Settings.",
        action: "settings",
      };
    case "loading":
      return { title: "Reading the sales engine…", description: "", action: null };
    case "off":
      return { title: "The engine's sales API is off", description, action: "retry" };
    case "unauthorised":
      return { title: "The engine refused the read token", description, action: "settings" };
    case "unreachable":
      return { title: "Can't reach the sales engine", description, action: "retry" };
    case "failed":
      return { title: "The sales engine sent an error", description, action: "retry" };
  }
}
