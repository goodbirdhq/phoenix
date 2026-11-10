import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import type { ModelSelection } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { canStartProviderSession, type ServerProvider } from "./server.ts";

/**
 * The Sales area reads one external sales engine. Phoenix stores none of this:
 * the server fetches the engine's read API, keeps the latest answer in memory,
 * and streams it to clients. See docs/adr/0005-sales-engine-adapter.md.
 *
 * The engine's v1 contract only grows. These schemas ignore fields they do not
 * know (Struct's default), read open enums as plain strings, and default
 * counts and nested groups, so an additive engine release never breaks a
 * client. The server decodes with them, which also strips anything new before
 * it reaches the wire.
 */

/** Where the engine's API sits below the root a person enters. */
export const SALES_API_PATH = "/api/sales/v1";

/**
 * The engine root a person entered: trimmed, without trailing slashes or the `/api/sales/v1`
 * suffix, so the origin and the API base name the same engine. Null when it is not an http or
 * https URL.
 */
export function salesEngineRoot(baseUrl: string): string | null {
  let root = baseUrl.trim().replace(/\/+$/u, "");
  if (root.endsWith(SALES_API_PATH))
    root = root.slice(0, -SALES_API_PATH.length).replace(/\/+$/u, "");
  if (!URL.canParse(root)) return null;
  const protocol = new URL(root).protocol;
  return protocol === "https:" || protocol === "http:" ? root : null;
}

/**
 * Which engine a URL names, for comparing settings and keying device keys: the root, in lower
 * case. Text that is not a URL keys as itself, trimmed and in lower case.
 */
export const salesEngineKey = (baseUrl: string) =>
  (salesEngineRoot(baseUrl) ?? baseUrl.trim()).toLowerCase();

const Count = Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0)));
const NullableString = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
const NullableCount = Schema.NullOr(Schema.Number).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
/** A nested object the engine may omit. Every field in one has a decoding default, so `{}` is a
    valid encoded value; the type system cannot see that through the generic. */
const group = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).pipe(
    Schema.withDecodingDefault(Effect.succeed({} as Schema.Struct<Fields>["Encoded"])),
  );

/** One entry of the engine's "Needs a look" list. Its text came from strangers: render as text. */
export const SalesLookItem = Schema.Struct({
  /** Open enum: `inbound`, `send`, `skip`, `refused`, ... Unknown values read as "other". */
  what: Schema.String,
  at: NullableString,
  who: NullableString,
  subject: NullableString,
  why: NullableString,
  /** The Activity row it is about, with its Notion page. Null for mail. */
  activityId: NullableString,
  notionUrl: NullableString,
});
export type SalesLookItem = typeof SalesLookItem.Type;

/** `GET /api/sales/v1/summary`: the counts the Home screen shows. */
export const SalesSummary = Schema.Struct({
  generatedAt: Schema.String,
  day: NullableString,
  timezone: NullableString,
  drafts: group({
    awaiting: group({
      total: Count,
      first: Count,
      chase: Count,
      revisit: Count,
      reply: Count,
      unknown: Count,
    }),
    approvedWaiting: Count,
    held: Count,
    paused: Count,
    refused: Count,
  }),
  autopilotToday: group({
    sent: Count,
    sending: Count,
    retrying: Count,
    failed: Count,
    scheduled: Count,
    held: Count,
    paused: Count,
    refused: Count,
  }),
  linkedin: group({
    outstanding: Count,
    onSlack: Count,
    pending: Count,
    budget: group({
      dailyLimit: NullableCount,
      sentToday: NullableCount,
      available: NullableCount,
    }),
  }),
  replies: group({ awaitingAnswer: Count, awaitingAnswerWithoutDraft: Count }),
  needsALook: group({
    count: Count,
    capped: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    items: Schema.Array(SalesLookItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  sendsToday: group({
    cold: Count,
    coldCap: Count,
    firstTouches: Count,
    firstTouchCap: Count,
    replies: Count,
    routeChasesApproved: Count,
    routeChaseCap: Count,
  }),
  mailboxes: group({ active: Count, warming: Count, benched: Count, retired: Count }),
  dispatcher: group({
    lastPokeAt: NullableString,
    pokeAgeSeconds: NullableCount,
    lastTickAt: NullableString,
    tickAgeSeconds: NullableCount,
    nextTickAt: NullableString,
    paused: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  }),
});
export type SalesSummary = typeof SalesSummary.Type;

const Bool = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));
const Text = Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("")));
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefault(Effect.succeed(null)));

/** Who held a paused route chase (a Slack user id, or `phoenix`) and when; set while `paused`. */
const SalesPause = nullable(Schema.Struct({ by: Text, at: NullableString }));

/** `ContactRef`: who a card or conversation is about, as the engine last read the CRM. */
export const SalesContactRef = Schema.Struct({
  id: Text,
  name: NullableString,
  email: NullableString,
  accountName: NullableString,
  timeZone: NullableString,
  effectiveTimeZone: NullableString,
  /** The Contact's Notion page. */
  notionUrl: NullableString,
  /** Their LinkedIn profile, when the engine has a LinkedIn task for them. */
  linkedinUrl: NullableString,
});
export type SalesContactRef = typeof SalesContactRef.Type;

/**
 * `QueueItem`: one draft's card and its approval. `kind` and `state` are open enums. Every
 * string here that came from a draft or a reply is text, never markup.
 */
export const SalesQueueItem = Schema.Struct({
  activityId: Schema.String,
  /** `first`, `chase`, `revisit`, `reply`, or null for a row name that is none of those. */
  kind: NullableString,
  step: NullableCount,
  stepLabel: NullableString,
  contact: SalesContactRef.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  campaign: NullableString,
  subject: Text,
  threaded: Bool,
  bodyPreview: Text,
  /** The card's current hash: exactly what an approval must be for. */
  contentHash: Schema.String,
  /**
   * `awaiting`, `approved`, `held` (by the engine), `paused` (a route chase someone held, which
   * Resume gives back), `refused`; closed: `sent`, `discarded`, `withdrawn`, `failed`.
   */
  state: Schema.String,
  approval: nullable(
    Schema.Struct({
      by: Schema.String,
      slackUserId: NullableString,
      deviceId: NullableString,
      at: NullableString,
    }),
  ),
  paused: SalesPause,
  sendAt: NullableString,
  /** The engine's words for when it goes. Display only. */
  goes: NullableString,
  mailbox: group({ sticky: Bool, address: NullableString, threadState: NullableString }),
  refusal: NullableString,
  note: NullableString,
  /** What to verify before approving. Outside the hash. */
  check: NullableString,
  skip: nullable(Schema.Struct({ reason: Schema.String, mailbox: NullableString })),
  sendStatus: NullableString,
  /** The Activity row in Notion. */
  notionUrl: NullableString,
  rowEditedAt: NullableString,
});
export type SalesQueueItem = typeof SalesQueueItem.Type;

/** `GET /queue`: every open card that waits on a person, oldest first. */
export const SalesQueue = Schema.Struct({
  generatedAt: Schema.String,
  timezone: NullableString,
  items: Schema.Array(SalesQueueItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesQueue = typeof SalesQueue.Type;

/**
 * The inputs of a card's content hash, exactly as the engine hashed them. Plain strings with no
 * trimming: the client recomputes the hash from these and shows these, so a decoder that
 * normalised them would break the check that what is signed is what was read.
 */
export const SalesHashInput = Schema.Struct({
  toAddress: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  rowName: Schema.String,
  step: Schema.NullOr(Schema.Number),
  gmailThreadId: nullable(Schema.String),
  answers: nullable(Schema.String),
});
export type SalesHashInput = typeof SalesHashInput.Type;

/**
 * `DispatchAction`: a thread Phoenix may start, built whole by the engine. `prompt` holds
 * `SALES_NOTE_TOKEN` exactly once; `fillSalesNote` puts the person's note there. `skill` is a
 * record of what runs and is never branched on.
 */
export const SalesDispatchAction = Schema.Struct({
  title: Schema.String,
  skill: Text,
  prompt: Schema.String,
  noteRequired: Bool,
  discardFirst: Bool,
  /** The card this action rewrites or replaces, at the version the plan was built for. */
  card: nullable(Schema.Struct({ activityId: Schema.String, expectedHash: Schema.String })),
});
export type SalesDispatchAction = typeof SalesDispatchAction.Type;

/** The plans the engine may offer, by the name a dispatch asks for. */
const SalesDispatchActionName = Schema.Literals(["redraft", "research", "answer"]);

/** `dispatch`: what may be started from a card or a conversation. Null is not offered. */
export const SalesDispatchPlans = Schema.Record(
  SalesDispatchActionName,
  nullable(SalesDispatchAction),
).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SalesDispatchPlans = typeof SalesDispatchPlans.Type;

/** Where the note goes in a dispatch prompt. */
export const SALES_NOTE_TOKEN = "{{note}}";
/** The line the engine's workflows find the person's note by. The engine owns its wording. */
const SALES_NOTE_LINE = "Note from Gabriel:";
const SALES_NOTE_MAX_CHARS = 2000;

/**
 * The person's note as it may enter a prompt: line breaks become LF, every other control
 * character or line separator a space, blank lines and trailing white space go, and it is cut to
 * 2,000 code points. Empty means no note.
 */
export function safeSalesNote(note: string): string {
  const lines = note
    .replace(/\r\n?/gu, "\n")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) => (char === "\n" ? char : " "))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return Array.from(lines.join("\n").trim()).slice(0, SALES_NOTE_MAX_CHARS).join("").trim();
}

/**
 * A dispatch prompt with the note block in place of `SALES_NOTE_TOKEN`, or nothing there when
 * the safe note is empty. Null for a prompt that does not hold the token exactly once. Split and
 * joined, never `String.replace`, which would read `$&` in a note as a pattern.
 */
export function fillSalesNote(prompt: string, note: string): string | null {
  const parts = prompt.split(SALES_NOTE_TOKEN);
  if (parts.length !== 2) return null;
  const safe = safeSalesNote(note);
  return parts[0] + (safe.length > 0 ? `\n${SALES_NOTE_LINE}\n${safe}` : "") + parts[1];
}

/** `GET /queue/:activityId`: one card in any state, with the full body and its hash inputs. */
export const SalesQueueItemDetail = Schema.Struct({
  ...SalesQueueItem.fields,
  body: Text,
  rowName: Text,
  hashInput: SalesHashInput,
  /** The engine's name for its hash. A client refuses to sign under one it does not know. */
  hashAlgorithm: Schema.String,
  dispatch: SalesDispatchPlans,
});
export type SalesQueueItemDetail = typeof SalesQueueItemDetail.Type;

export const SalesReplyClassification = Schema.Struct({
  /** Open enum: `interested`, `deferred`, `declined`, `redirect`, `ooo`, `bounce`, ... */
  intent: Schema.String,
  summary: NullableString,
  confidence: NullableString,
  revisitOn: NullableString,
  redirectTo: nullable(Schema.Struct({ name: NullableString, email: NullableString })),
});
export type SalesReplyClassification = typeof SalesReplyClassification.Type;

/** One contact's replies as `GET /conversations` groups them. */
export const SalesConversation = Schema.Struct({
  contactKey: Schema.String,
  contact: SalesContactRef.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  mailboxes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  replyCount: Count,
  latestReply: nullable(
    Schema.Struct({
      gmailMessageId: Text,
      receivedAt: NullableString,
      mailbox: NullableString,
      subject: NullableString,
      preview: Text,
      classification: nullable(SalesReplyClassification),
    }),
  ),
  lastSentAt: NullableString,
  threadState: NullableString,
  awaitingAnswer: Bool,
  hasOpenDraft: Bool,
  replyDraft: nullable(
    Schema.Struct({ activityId: Schema.String, state: Schema.String, contentHash: Schema.String }),
  ),
});
export type SalesConversation = typeof SalesConversation.Type;

export const SalesConversationList = Schema.Struct({
  generatedAt: Schema.String,
  items: Schema.Array(SalesConversation).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesConversationList = typeof SalesConversationList.Type;

export const SalesConversationMessage = Schema.Struct({
  /** `out`: an engine send. `in`: a message from them. */
  direction: Schema.String,
  /** `email` for ours; `reply`, `ooo`, `bounce` or `linkedin` for theirs. */
  kind: Schema.String,
  id: Text,
  at: NullableString,
  mailbox: NullableString,
  gmailThreadId: NullableString,
  subject: NullableString,
  text: Text,
  step: NullableCount,
  status: NullableString,
  bounced: NullableString,
  error: NullableString,
  classification: nullable(SalesReplyClassification),
});
export type SalesConversationMessage = typeof SalesConversationMessage.Type;

/** `GET /conversations/:contactKey`: one contact's history across every pool mailbox. */
export const SalesConversationDetail = Schema.Struct({
  generatedAt: Schema.String,
  contactKey: Schema.String,
  contact: SalesContactRef.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  thread: nullable(
    Schema.Struct({
      mailbox: NullableString,
      toAddress: NullableString,
      state: NullableString,
      stateReason: NullableString,
      sends: Count,
      firstSentAt: NullableString,
      lastSentAt: NullableString,
    }),
  ),
  messages: Schema.Array(SalesConversationMessage).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  drafts: Schema.Array(SalesQueueItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  dispatch: SalesDispatchPlans,
});
export type SalesConversationDetail = typeof SalesConversationDetail.Type;

/** Their newest out-of-office, when it says they are back today or later (`outOfOffice`). */
export const SalesOutOfOffice = Schema.Struct({
  returnOn: NullableString,
  /** The engine's words for the window, from their auto-reply. */
  window: Text,
  receivedAt: NullableString,
});
export type SalesOutOfOffice = typeof SalesOutOfOffice.Type;

/** One send of today, done or to come, as `GET /autopilot/today` lists it. */
export const SalesAutopilotItem = Schema.Struct({
  activityId: Schema.String,
  /**
   * Open enum: `sent`, `sending`, `retrying`, `failed`, `scheduled`, `held` (by the engine),
   * `paused` (a route chase someone held, which Resume gives back), `refused`.
   */
  state: Schema.String,
  /** When it went or was tried, its slot, or when it was held or refused. */
  at: NullableString,
  /** `route` (the engine approved it, no press), `press`, or null for a send with no card. */
  approval: NullableString,
  kind: NullableString,
  step: NullableCount,
  contact: SalesContactRef.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  campaign: NullableString,
  subject: NullableString,
  mailbox: NullableString,
  /** Why it is held, refused or failed. */
  reason: NullableString,
  paused: SalesPause,
  outOfOffice: nullable(SalesOutOfOffice),
});
export type SalesAutopilotItem = typeof SalesAutopilotItem.Type;

/** `GET /autopilot/today`: what goes out today, or went, in time order. */
export const SalesAutopilotToday = Schema.Struct({
  generatedAt: Schema.String,
  day: NullableString,
  timezone: NullableString,
  items: Schema.Array(SalesAutopilotItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesAutopilotToday = typeof SalesAutopilotToday.Type;

/** One open LinkedIn task (`GET /tasks`). */
export const SalesTask = Schema.Struct({
  id: Schema.String,
  /** Open enum: `connect` or `dm`. */
  action: Schema.String,
  /** `posted`: its card is on Slack. `pending`: not on a card yet. */
  status: Schema.String,
  /** The engine's day it falls due, `YYYY-MM-DD`. */
  dueOn: NullableString,
  /**
   * The day it took a place in the invite budget, or null while it waits for one. A connection
   * request without a place cannot be reported sent.
   */
  admittedOn: NullableString,
  frontOfQueue: Bool,
  contact: SalesContactRef.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** The note the card suggests, once posted. */
  suggestedText: NullableString,
  /** Open enum: `unknown`, `pending`, `connected`. */
  connectionState: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("unknown"))),
});
export type SalesTask = typeof SalesTask.Type;

/** Today's connection-request budget. `day` is the engine's today, `YYYY-MM-DD`. */
const SalesTaskBudget = group({
  day: NullableString,
  dailyLimit: NullableCount,
  available: NullableCount,
});
export type SalesTaskBudget = typeof SalesTaskBudget.Type;

export const SalesTaskList = Schema.Struct({
  generatedAt: Schema.String,
  items: Schema.Array(SalesTask).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  budget: SalesTaskBudget,
});
export type SalesTaskList = typeof SalesTaskList.Type;

/** What a person did about a LinkedIn task, as its card reports it. */
export const SalesTaskOutcome = Schema.Literals([
  "request_sent",
  "pending",
  "connected",
  "connected_message",
  "pending_message",
  "skip",
]);
export type SalesTaskOutcome = typeof SalesTaskOutcome.Type;

/**
 * What each task's card offers, in the order it shows them: the engine's
 * `LINKEDIN_CARD_OUTCOMES`, which also draws its Slack buttons. An action not listed offers none.
 */
export const SALES_TASK_OUTCOMES: Readonly<Record<string, ReadonlyArray<SalesTaskOutcome>>> = {
  connect: ["request_sent", "pending", "connected", "skip", "connected_message", "pending_message"],
  dm: ["request_sent", "skip"],
};

export const SalesTaskReportInput = Schema.Struct({
  taskId: Schema.String,
  outcome: SalesTaskOutcome,
});
export type SalesTaskReportInput = typeof SalesTaskReportInput.Type;

/**
 * What a report did. `result` is an open enum: `recorded` (it stands now), `already` (it stood
 * already), `held` (the engine's live check could not clear it now; `reason` says why, and the task
 * stays open), `skipped` (the check ruled them out, so it was skipped instead; `reason`), or
 * `backlog_paused` (a backlog task while backlog admission is off). `budget` is today's after it.
 */
export const SalesTaskReport = Schema.Struct({
  result: Schema.String,
  reason: NullableString,
  task: Schema.Struct({
    id: Schema.String,
    action: Text,
    status: Text,
    outcome: NullableString,
    connectionState: NullableString,
  }),
  budget: SalesTaskBudget,
});
export type SalesTaskReport = typeof SalesTaskReport.Type;

export const SalesCampaignStep = Schema.Struct({
  step: Schema.Number,
  sent: Count,
  bounced: Count,
  replied: Count,
  positive: Count,
});
export type SalesCampaignStep = typeof SalesCampaignStep.Type;

/** People and steps of one campaign, from what the engine sent (`GET /campaigns`). */
export const SalesCampaign = Schema.Struct({
  /** Null collects contacts whose emails carry no campaign. */
  campaign: NullableString,
  contacts: Count,
  replied: Count,
  positive: Count,
  declined: Count,
  bounced: Count,
  steps: Schema.Array(SalesCampaignStep).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesCampaign = typeof SalesCampaign.Type;

export const SalesCampaignList = Schema.Struct({
  generatedAt: Schema.String,
  items: Schema.Array(SalesCampaign).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesCampaignList = typeof SalesCampaignList.Type;

/** One pool mailbox (`GET /mailboxes`). */
export const SalesMailbox = Schema.Struct({
  address: Schema.String,
  /** Open enum: `warming`, `active`, `benched`, `retired`. Only `active` sends. */
  status: Schema.String,
  /** Why, for a person. Never parsed. */
  statusReason: NullableString,
  dailyCap: Count,
  coldSentToday: Count,
  repliesSentToday: Count,
  bouncesToday: Count,
  hardBouncesInWindow: Count,
  /** No cold email before this: its rest after the last send. */
  restUntil: NullableString,
  /** The earliest approved slot to come for a send that must leave from it. */
  nextSlotAt: NullableString,
  /** When inbound sync last read its whole window. */
  lastSyncedAt: NullableString,
});
export type SalesMailbox = typeof SalesMailbox.Type;

export const SalesMailboxList = Schema.Struct({
  generatedAt: Schema.String,
  /** The engine benches a mailbox at `threshold` hard bounces among its last `window` sends. */
  bounceRule: group({ window: Count, threshold: Count }),
  items: Schema.Array(SalesMailbox).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesMailboxList = typeof SalesMailboxList.Type;

/** `GET /health`: what the engine's daily health message would say now. */
export const SalesHealth = Schema.Struct({
  generatedAt: Schema.String,
  healthy: Bool,
  /**
   * Slack mrkdwn, a line per finding, with `&`, `<` and `>` escaped. It already names any
   * scheduled run that has not finished (`overdueRuns`), so Phoenix reads no more than this.
   */
  text: Text,
});
export type SalesHealth = typeof SalesHealth.Type;

/** A card as an action leaves it (`CardState`). */
export const SalesCardState = Schema.Struct({
  activityId: Schema.String,
  contentHash: Schema.String,
  state: Schema.String,
  approved: Bool,
  approvedBy: NullableString,
  sendAt: NullableString,
  goes: NullableString,
  refusal: NullableString,
  note: NullableString,
  paused: SalesPause,
  /**
   * A send row already exists: `claimed` (going now: nothing taken back stops it), `retry`,
   * `sent`, `failed`. Null before any attempt.
   */
  sendStatus: NullableString,
});
export type SalesCardState = typeof SalesCardState.Type;

/** The public half of a device's P-256 key, as `crypto.subtle.exportKey("jwk")` gives it. */
export const SalesDevicePublicKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});
export type SalesDevicePublicKey = typeof SalesDevicePublicKey.Type;

/** A device that signs approvals. Only `active` signs. */
export const SalesDevice = Schema.Struct({
  deviceId: Schema.String,
  name: Text,
  /** `pending`, `active`, `rejected`, `revoked`. */
  state: Schema.String,
  fingerprint: Text,
  fingerprintShort: Text,
  createdAt: NullableString,
  decidedAt: NullableString,
  revokedBy: NullableString,
  revokedAt: NullableString,
  lastUsedAt: NullableString,
});
export type SalesDevice = typeof SalesDevice.Type;

export const SalesDeviceList = Schema.Struct({
  items: Schema.Array(SalesDevice).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SalesDeviceList = typeof SalesDeviceList.Type;

export const SalesEnrolDeviceInput = Schema.Struct({
  deviceId: Schema.String,
  name: Schema.String,
  publicKeyJwk: SalesDevicePublicKey,
});
export type SalesEnrolDeviceInput = typeof SalesEnrolDeviceInput.Type;

/**
 * One press, signed on the device. The server relays these untouched: it holds no device key,
 * so it cannot make or alter one.
 */
export const SalesSignedApproval = Schema.Struct({
  activityId: Schema.String,
  contentHash: Schema.String,
  deviceId: Schema.String,
  /** `new Date().toISOString()` at the press, exactly as signed. */
  signedAt: Schema.String,
  /** base64url of the 64-byte IEEE P1363 ECDSA signature. */
  signature: Schema.String,
});
export type SalesSignedApproval = typeof SalesSignedApproval.Type;

/** The engine's batch limit for `POST /actions/approve`. */
export const SALES_APPROVE_BATCH_LIMIT = 25;

export const SalesApproveInput = Schema.Struct({
  items: Schema.Array(SalesSignedApproval).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SALES_APPROVE_BATCH_LIMIT),
  ),
});
export type SalesApproveInput = typeof SalesApproveInput.Type;

/** Why the engine turned one signed approval away. `other` is a reason this build does not know. */
export const SalesApproveFailureReason = Schema.Literals([
  "bad_request",
  "device_not_active",
  "expired",
  "bad_signature",
  "replayed",
  "not_found",
  "not_open",
  "refused",
  "stale_hash",
  "other",
]);
export type SalesApproveFailureReason = typeof SalesApproveFailureReason.Type;

export const SalesApproveItemResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), already: Schema.Boolean, card: SalesCardState }),
  Schema.Struct({
    ok: Schema.Literal(false),
    activityId: Schema.String,
    reason: SalesApproveFailureReason,
    message: Schema.String,
    /** Set for `stale_hash`: the version the card shows now. */
    currentHash: Schema.NullOr(Schema.String),
  }),
]);
export type SalesApproveItemResult = typeof SalesApproveItemResult.Type;

export const SalesApproveResult = Schema.Struct({
  /** In the order of the request's items. */
  results: Schema.Array(SalesApproveItemResult),
});
export type SalesApproveResult = typeof SalesApproveResult.Type;

export const SalesEditInput = Schema.Struct({
  activityId: Schema.String,
  expectedHash: Schema.String,
  /** Only for a new thread. Omitted, the subject stays. */
  subject: Schema.optionalKey(Schema.String),
  body: Schema.String,
});
export type SalesEditInput = typeof SalesEditInput.Type;

export const SalesEditResult = Schema.Struct({
  card: SalesCardState,
  approvalLapsed: Schema.Boolean,
});
export type SalesEditResult = typeof SalesEditResult.Type;

/**
 * What Hold did: `paused` a chase the route approved (Resume gives it back), or `unapproved` a
 * person's approval, which only a fresh press restores. Either way check `card.sendStatus`:
 * `claimed` means a send was already under way and was not stopped.
 */
export const SalesHoldResult = Schema.Struct({
  card: SalesCardState,
  already: Schema.Boolean,
  result: Schema.Literals(["paused", "unapproved"]),
});
export type SalesHoldResult = typeof SalesHoldResult.Type;

/** Gives a paused route chase back to the route, for the version the person saw. */
export const SalesResumeInput = Schema.Struct({
  activityId: Schema.String,
  expectedHash: Schema.String,
});
export type SalesResumeInput = typeof SalesResumeInput.Type;

export const SalesResumeResult = Schema.Struct({
  card: SalesCardState,
  /** It was approved for that version already: it is going. */
  already: Schema.Boolean,
});
export type SalesResumeResult = typeof SalesResumeResult.Type;

/**
 * Start one of the engine's dispatch plans, from the card (`activityId`) or the conversation
 * (`contactKey`) that offered it. `expectedHash` is the plan's `card.expectedHash` as the person
 * saw it, or null for a plan without a card.
 */
export const SalesDispatchInput = Schema.Union([
  Schema.Struct({
    activityId: Schema.String,
    action: SalesDispatchActionName,
    expectedHash: Schema.NullOr(Schema.String),
    note: Schema.String,
  }),
  Schema.Struct({
    contactKey: Schema.String,
    action: SalesDispatchActionName,
    expectedHash: Schema.NullOr(Schema.String),
    note: Schema.String,
  }),
]);
export type SalesDispatchInput = typeof SalesDispatchInput.Type;

/** A thread a dispatch started. */
export const SalesDispatch = Schema.Struct({ threadId: ThreadId, title: Schema.String });
export type SalesDispatch = typeof SalesDispatch.Type;

/** The card (`activityId`) or conversation (`contactKey`) a dispatch started from. */
export type SalesDispatchSource = { readonly activityId: string } | { readonly contactKey: string };

/**
 * The one definition of a dispatched thread's id: `sales:card:<activityId>:<uuid>` or
 * `sales:contact:<contactKey>:<uuid>`, the key URI-encoded so it holds no `:`. The source is part
 * of the id, so the read model remembers it across restarts. The contact key is the CRM's Contact
 * page id, not an email, so the id carries no personal data and needs no hashing.
 *
 * This is the prefix of every id dispatched from one source: a source's runs are the threads
 * whose id starts with it.
 */
export const salesDispatchThreadPrefix = (source: SalesDispatchSource) =>
  "activityId" in source
    ? `sales:card:${encodeURIComponent(source.activityId)}:`
    : `sales:contact:${encodeURIComponent(source.contactKey)}:`;

/**
 * What a Sales run starts on when Settings chooses no agent: Claude Code on its default model,
 * or null when no Claude Code instance can start. Sales never falls back to another provider.
 */
export const defaultSalesRunModel = (
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null => {
  const claude = providers.find(
    (provider) =>
      provider.driver === ProviderDriverKind.make("claudeAgent") &&
      canStartProviderSession(provider),
  );
  const model = claude?.models.find((entry) => entry.isDefault === true) ?? claude?.models[0];
  return claude === undefined || model === undefined
    ? null
    : { instanceId: claude.instanceId, model: model.slug };
};

/**
 * The refusal codes the engine sends (`error` in its error body), spelled as it spells them. A
 * code this build does not know reads as `other`, with the engine's message.
 * `budget`: the engine ran out of requests mid-call; read before retrying.
 */
export const SalesEngineFailureCode = Schema.Literals([
  "budget",
  "bad_request",
  "bad_key",
  "device_exists",
  "too_many_pending",
  "slack_failed",
  "not_found",
  "not_revocable",
  "not_open",
  "not_approved",
  "stale_hash",
  "changed_in_notion",
  "row_gone",
  "notion_failed",
  "empty_body",
  "body_too_long",
  "subject_required",
  "subject_not_editable",
  "needs_press",
  "chase_cap",
  "refused",
  "not_offered",
  "not_admitted",
  "other",
]);
export type SalesEngineFailureCode = typeof SalesEngineFailureCode.Type;

/**
 * Why a sales request failed, as clients show it. Each reason has one origin, except the few
 * engine codes Phoenix also raises itself (`stale_hash`, `bad_request`) when it
 * checks a card before dispatching.
 *
 * Phoenix refused before asking the engine:
 * - `not-configured`: no engine URL, or no token for this half of the API.
 * - `bad-url`: an engine URL that is not http or https.
 * - `no-agents-project`, `agents-project-missing`, `no-target`, `dispatch-failed`: dispatch.
 *
 * No engine answer Phoenix could read:
 * - `unreachable`: the request did not complete.
 * - `unreadable-answer`: an HTTP error without the engine's body, or a body Phoenix could not
 *   decode.
 *
 * The engine refused: `api-off` / `actions-off` (that half is turned off), `unauthorised` (it
 * refused the token), or one of its own codes.
 */
export const SalesActionFailureReason = Schema.Literals([
  "not-configured",
  "bad-url",
  "no-agents-project",
  "agents-project-missing",
  "no-target",
  "dispatch-failed",
  "unreachable",
  "unreadable-answer",
  "api-off",
  "actions-off",
  "unauthorised",
  ...SalesEngineFailureCode.literals,
]);
export type SalesActionFailureReason = typeof SalesActionFailureReason.Type;

/**
 * Who a sales failure came from, which says whether the request may still have landed:
 * - `transport`: no engine answer Phoenix could read. It may have landed.
 * - `engine`: the engine answered and refused, with one of its codes or a 401.
 * - `phoenix`: this server refused before asking the engine.
 */
export const SalesFailureOrigin = Schema.Literals(["transport", "engine", "phoenix"]);
export type SalesFailureOrigin = typeof SalesFailureOrigin.Type;

export class SalesActionError extends Schema.TaggedError<SalesActionError>()("SalesActionError", {
  /** Servers before `origin` existed omit it; reading it as `transport` claims the least. */
  origin: SalesFailureOrigin.pipe(Schema.withDecodingDefault(Effect.succeed("transport"))),
  reason: SalesActionFailureReason,
  message: Schema.String,
  /** Set when the card moved on (`stale_hash`, `changed_in_notion`, ...): its version now. */
  currentHash: Schema.NullOr(Schema.String),
  /** Set for `not_open` and `not_revocable`: the state (or a task's status) it is in. */
  state: Schema.NullOr(Schema.String),
}) {}

/**
 * Where the server stands with the engine:
 * - `not-configured`: no engine URL or read token in this environment's settings.
 * - `loading`: configured, first answer not in yet.
 * - `ready`: the last read succeeded.
 * - `off`: the engine answered 503 `sales_api_off` (no read token set on its side).
 * - `unauthorised`: the engine refused the token (401).
 * - `unreachable`: the request did not complete (network, DNS, timeout).
 * - `failed`: any other answer, a body the server could not read, or a URL it cannot use.
 */
export const SalesEngineStatus = Schema.Literals([
  "not-configured",
  "loading",
  "ready",
  "off",
  "unauthorised",
  "unreachable",
  "failed",
]);
export type SalesEngineStatus = typeof SalesEngineStatus.Type;

export const SalesSnapshot = Schema.Struct({
  status: SalesEngineStatus,
  /** Human text for a non-ready status. */
  message: Schema.NullOr(Schema.String),
  /** The last summary read from this engine. Kept through later errors, so it may be stale. */
  summary: Schema.NullOr(SalesSummary),
  /** The open cards, read with the summary. Kept through later errors like it. */
  queue: Schema.NullOr(SalesQueue).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** When `summary` was read. */
  summaryReadAt: Schema.NullOr(IsoDateTime),
  /** When the server last asked the engine, successfully or not. */
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type SalesSnapshot = typeof SalesSnapshot.Type;

/**
 * - `sales-snapshot` replaces the client's snapshot.
 * - `sales-read`: a read found nothing new. Only the read times moved; the summary's dispatcher
 *   ages, measured at `summaryReadAt`, are older by the time between the two reads.
 */
export const SalesStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sales-snapshot"), snapshot: SalesSnapshot }),
  Schema.Struct({
    type: Schema.Literal("sales-read"),
    summaryReadAt: Schema.NullOr(IsoDateTime),
    checkedAt: Schema.NullOr(IsoDateTime),
  }),
]);
export type SalesStreamEvent = typeof SalesStreamEvent.Type;

/**
 * The latest read of one engine list a Sales area shows, sent whenever it says something new.
 * `data` is kept through later errors, so beside a non-ready status it is stale. `readAt` is the
 * last read that succeeded when this was sent. Reads that find nothing new are not sent, so on a
 * ready view it can lag; a failed read is sent at once, so beside an error it is the last time the
 * engine confirmed `data`.
 */
const salesView = <View extends string, Data extends Schema.Top>(view: View, data: Data) =>
  Schema.Struct({
    view: Schema.Literal(view),
    status: SalesEngineStatus,
    message: Schema.NullOr(Schema.String),
    data: Schema.NullOr(data),
    readAt: Schema.NullOr(IsoDateTime),
  });

export const SalesView = Schema.Union([
  salesView("autopilot", SalesAutopilotToday),
  salesView("tasks", SalesTaskList),
  salesView("campaigns", SalesCampaignList),
  salesView("mailboxes", SalesMailboxList),
  salesView("health", SalesHealth),
]);
export type SalesView = typeof SalesView.Type;
export const SalesViewName = Schema.Literals(
  SalesView.members.map((member) => member.fields.view.literal),
);
export type SalesViewName = typeof SalesViewName.Type;

export const SALES_WS_METHODS = {
  getSnapshot: "sales.getSnapshot",
  refresh: "sales.refresh",
  subscribe: "sales.subscribe",
  subscribeView: "sales.subscribeView",
  getQueueItem: "sales.getQueueItem",
  listConversations: "sales.listConversations",
  getConversation: "sales.getConversation",
  approve: "sales.approve",
  hold: "sales.hold",
  resume: "sales.resume",
  edit: "sales.edit",
  discard: "sales.discard",
  reportTask: "sales.reportTask",
  listDevices: "sales.listDevices",
  enrolDevice: "sales.enrolDevice",
  revokeDevice: "sales.revokeDevice",
  dispatch: "sales.dispatch",
} as const;
