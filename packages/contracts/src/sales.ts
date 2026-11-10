import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";

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
    refused: Count,
  }),
  autopilotToday: group({
    sent: Count,
    sending: Count,
    retrying: Count,
    failed: Count,
    scheduled: Count,
    held: Count,
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
  /** Not in v1's ContactRef for drafts; read when the engine adds it. */
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
  /** `awaiting`, `approved`, `held`, `refused`; closed: `sent`, `discarded`, `withdrawn`, `failed`. */
  state: Schema.String,
  approval: nullable(
    Schema.Struct({
      by: Schema.String,
      slackUserId: NullableString,
      deviceId: NullableString,
      at: NullableString,
    }),
  ),
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

/** `GET /queue/:activityId`: one card in any state, with the full body and its hash inputs. */
export const SalesQueueItemDetail = Schema.Struct({
  ...SalesQueueItem.fields,
  body: Text,
  rowName: Text,
  hashInput: SalesHashInput,
  /** The engine's name for its hash. A client refuses to sign under one it does not know. */
  hashAlgorithm: Schema.String,
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
});
export type SalesConversationDetail = typeof SalesConversationDetail.Type;

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
 * What a dispatch starts, in the configured sales agents project:
 * - `research`: `prospect-research` for the card's account, its contact as the candidate.
 * - `redraft`: rewrite a waiting draft with a note. A first touch, chase or revisit is rewritten
 *   in place by its workflow; a reply draft is discarded (for `expectedHash`) and drafted again,
 *   since the reply drafter cannot edit a row.
 * - `draft-reply`: draft an answer for a conversation that has none.
 */
export const SalesDispatchInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("research"), activityId: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("redraft"),
    activityId: Schema.String,
    expectedHash: Schema.String,
    note: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("draft-reply"),
    contactKey: Schema.String,
    note: Schema.String,
  }),
]);
export type SalesDispatchInput = typeof SalesDispatchInput.Type;

/** A thread a dispatch started. `target` is the card's activityId or the contact's key. */
export const SalesDispatch = Schema.Struct({
  target: Schema.String,
  action: Schema.Literals(["research", "redraft", "draft-reply"]),
  skill: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  startedAt: IsoDateTime,
});
export type SalesDispatch = typeof SalesDispatch.Type;

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
  "other",
]);
export type SalesEngineFailureCode = typeof SalesEngineFailureCode.Type;

/**
 * Why a sales request failed, as clients show it: one of the engine's codes, or one of these:
 * - `not-configured`: no engine URL, or no token for this half of the API.
 * - `api-off` / `actions-off`: the engine has that half turned off.
 * - `unauthorised`: the engine refused the token.
 * - `unreachable`: the request did not complete.
 * - `failed`: an answer Phoenix could not read, or an engine URL it cannot use.
 * - `no-agents-project`, `agents-project-missing`, `no-target`, `dispatch-failed`: dispatch.
 *
 * Phoenix itself also uses a few engine codes (`stale_hash`, `not_open`, `bad_request`) when it
 * checks a card before dispatching; `origin` says who refused.
 */
export const SalesActionFailureReason = Schema.Literals([
  "not-configured",
  "api-off",
  "actions-off",
  "unauthorised",
  "unreachable",
  "failed",
  "no-agents-project",
  "agents-project-missing",
  "no-target",
  "dispatch-failed",
  ...SalesEngineFailureCode.literals,
]);
export type SalesActionFailureReason = typeof SalesActionFailureReason.Type;

/**
 * Who a sales failure came from, which says whether the request may still have landed:
 * - `transport`: no engine answer Phoenix could read (unreachable, timed out, an HTTP error
 *   without the engine's body, a body it could not decode). It may have landed.
 * - `engine`: the engine answered and refused, with one of its codes or a 401.
 * - `phoenix`: this server refused before asking the engine (settings, dispatch checks).
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
  /** Set for `not_open` and `not_revocable`: the state it is in. */
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
 * - `failed`: any other answer, or a body the server could not read.
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
  /** Threads dispatched from Sales since the server started, newest first. Memory only. */
  dispatches: Schema.Array(SalesDispatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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

export const SALES_WS_METHODS = {
  getSnapshot: "sales.getSnapshot",
  refresh: "sales.refresh",
  subscribe: "sales.subscribe",
  getQueueItem: "sales.getQueueItem",
  listConversations: "sales.listConversations",
  getConversation: "sales.getConversation",
  approve: "sales.approve",
  unapprove: "sales.unapprove",
  edit: "sales.edit",
  discard: "sales.discard",
  listDevices: "sales.listDevices",
  enrolDevice: "sales.enrolDevice",
  revokeDevice: "sales.revokeDevice",
  dispatch: "sales.dispatch",
} as const;
