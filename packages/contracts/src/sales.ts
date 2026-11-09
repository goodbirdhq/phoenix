import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

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
  replies: group({ awaitingAnswer: Count }),
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
  /** When `summary` was read. */
  summaryReadAt: Schema.NullOr(IsoDateTime),
  /** When the server last asked the engine, successfully or not. */
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type SalesSnapshot = typeof SalesSnapshot.Type;

/** Each event replaces the client's snapshot. A union so later areas (queue) can be added. */
export const SalesStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sales-snapshot"), snapshot: SalesSnapshot }),
]);
export type SalesStreamEvent = typeof SalesStreamEvent.Type;

export const SALES_WS_METHODS = {
  getSnapshot: "sales.getSnapshot",
  refresh: "sales.refresh",
  subscribe: "sales.subscribe",
} as const;
