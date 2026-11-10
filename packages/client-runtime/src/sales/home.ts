import type { SalesLookItem, SalesSnapshot, SalesSummary } from "@t3tools/contracts";

import { SALES_AREA_LABELS, type SalesArea } from "./areas.ts";
import { safeHttpsUrl } from "./links.ts";

/** The work areas the engine's summary covers, in the order Home lists them. */
type SalesWorkAreaKey = Extract<SalesArea, "outreach" | "autopilot" | "todo" | "conversations">;

export interface SalesHomeFigure {
  readonly label: string;
  readonly value: string;
}

export interface SalesHomeArea {
  readonly key: SalesWorkAreaKey;
  readonly label: string;
  /** Items in this area that wait on a person. */
  readonly count: number;
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
  const { awaiting, approvedWaiting, held, paused, refused } = summary.drafts;
  const status =
    awaiting.total > 0
      ? `${plural(awaiting.total, "draft")} ${awaiting.total === 1 ? "waits" : "wait"} for approval`
      : refused > 0
        ? `${plural(refused, "draft")} refused; an edit in Notion lifts it`
        : "Nothing waits for approval";
  return {
    key: "outreach",
    label: SALES_AREA_LABELS.outreach,
    count: awaiting.total,
    status,
    figures: [
      { label: "Approved", value: String(approvedWaiting) },
      { label: "Held", value: String(held) },
      { label: "Paused", value: String(paused) },
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
    label: SALES_AREA_LABELS.autopilot,
    // Refusals get a normal card, so Outreach already counts them.
    count: today.failed,
    status,
    figures: [
      { label: "Sent", value: String(today.sent) },
      { label: "Scheduled", value: String(today.scheduled) },
      { label: "Held", value: String(today.held) },
      { label: "Paused", value: String(today.paused) },
    ],
  };
}

function todo(summary: SalesSummary): SalesHomeArea {
  const { onSlack, pending, budget } = summary.linkedin;
  const status =
    onSlack > 0
      ? `${plural(onSlack, "LinkedIn task")} ready to do`
      : pending > 0
        ? `${plural(pending, "LinkedIn task")} not posted yet`
        : "No LinkedIn tasks";
  return {
    key: "todo",
    label: SALES_AREA_LABELS.todo,
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
  const { awaitingAnswer, awaitingAnswerWithoutDraft } = summary.replies;
  const drafted = awaitingAnswer - awaitingAnswerWithoutDraft;
  return {
    key: "conversations",
    label: SALES_AREA_LABELS.conversations,
    // A reply with a drafted answer already counts under Outreach, as a draft waiting.
    count: awaitingAnswerWithoutDraft,
    status:
      awaitingAnswerWithoutDraft > 0
        ? `${plural(awaitingAnswerWithoutDraft, "reply", "replies")} ${awaitingAnswerWithoutDraft === 1 ? "has" : "have"} no answer drafted`
        : drafted > 0
          ? `${plural(drafted, "answer")} drafted, waiting for approval`
          : "Every reply has an answer",
    figures: [
      { label: "Reply drafts", value: String(summary.drafts.awaiting.reply) },
      { label: "Replies sent today", value: String(summary.sendsToday.replies) },
    ],
  };
}

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
  const areas = [outreach(summary), autopilot(summary), todo(summary), conversations(summary)];
  const needsYou = areas.reduce((total, area) => total + area.count, 0);
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

/** What to say for a snapshot, or an area's read, that is not a fresh answer. Null when it is. */
export function salesStatusNotice(
  snapshot: Pick<SalesSnapshot, "status" | "message">,
): SalesStatusNotice | null {
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
      return { title: "Could not read the sales engine", description, action: "retry" };
  }
}

const NOTION_PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu;

const LOOK_WHAT: Record<string, string> = {
  inbound: "Inbound email",
  send: "A send",
  skip: "A skipped send",
  refused: "A refused draft",
};

export interface SalesLookItemView {
  /** Who and what, never a bare id. */
  readonly title: string;
  readonly why: string | null;
  /** The Notion page it is about: the engine's link, or the page an id in `who` names. */
  readonly notionUrl: string | null;
}

/**
 * One "Needs a look" line. The engine may send a CRM page id as `who` where it has no name; that
 * reads as nothing to a person, so the line falls back to the subject or reason and links the page.
 */
export function lookItemView(item: SalesLookItem): SalesLookItemView {
  const pageId = item.who !== null && NOTION_PAGE_ID.test(item.who) ? item.who : null;
  const who = pageId === null ? item.who : null;
  const title =
    [who, item.subject].filter(Boolean).join(" · ") ||
    item.why ||
    (LOOK_WHAT[item.what] ?? "Something");
  return {
    title,
    why: title === item.why ? null : item.why,
    notionUrl:
      safeHttpsUrl(item.notionUrl) ??
      (pageId === null ? null : `https://www.notion.so/${pageId.replaceAll("-", "")}`),
  };
}

/**
 * The engine's day, for the Home's "Updated" line, only when it is not the viewer's own date at
 * the moment the summary was made: "today" then means the engine's day, not the viewer's. Null
 * otherwise.
 */
export function engineDayNote(summary: SalesSummary, viewerTimeZone: string): string | null {
  const { day, timezone } = summary;
  const dayMs = day === null ? Number.NaN : Date.parse(`${day}T00:00:00Z`);
  const generatedAt = Date.parse(summary.generatedAt);
  if (Number.isNaN(dayMs) || Number.isNaN(generatedAt)) return null;
  // en-CA writes a date as YYYY-MM-DD, the engine's form.
  const viewerDay = new Intl.DateTimeFormat("en-CA", { timeZone: viewerTimeZone }).format(
    generatedAt,
  );
  if (viewerDay === day) return null;
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dayMs);
  const place = timezone === null ? null : (timezone.split("/").at(-1) ?? timezone);
  return place === null
    ? `Engine day ${date}`
    : `Engine day ${date} (${place.replaceAll("_", " ")})`;
}
