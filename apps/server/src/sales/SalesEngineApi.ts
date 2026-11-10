import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  SalesActionError,
  type SalesActionFailureReason,
  SalesActionFailureReason as SalesActionFailureReasonSchema,
  SalesApproveFailureReason,
  type SalesApproveInput,
  type SalesApproveItemResult,
  SalesCardState,
  SalesConversationDetail,
  SalesConversationList,
  SalesDevice,
  SalesDeviceList,
  type SalesEditInput,
  type SalesEnrolDeviceInput,
  SalesQueue,
  SalesQueueItemDetail,
  SalesSummary,
  SALES_API_PATH,
  salesEngineRoot,
} from "@t3tools/contracts";

/**
 * The adapter for the external sales engine's API (`/api/sales/v1`). Everything engine-shaped
 * stays here: the paths, which token opens which half, and how its answers map to Phoenix's
 * reasons. The contract lives with the engine, in its `docs/sales-api.md`.
 *
 * Two halves on two tokens: the views (GET, read token) and the actions and devices (action
 * token). Neither half lets this server approve anything by itself: an approval is a signature
 * made on an enrolled device, which this module only carries.
 */

const READ_TIMEOUT = "15 seconds";
/** Edit writes to Notion before it answers, which takes a few seconds and a few requests. */
const ACTION_TIMEOUT = "45 seconds";

export interface SalesEngineConfig {
  readonly baseUrl: string;
  readonly readToken: string;
  readonly actionToken: string;
}

type Half = "read" | "action";

/** The API base for the URL a person entered; null when it is not an http(s) URL. */
const salesApiBaseUrl = (baseUrl: string) => {
  const root = salesEngineRoot(baseUrl);
  return root === null ? null : `${root}${SALES_API_PATH}`;
};

const DEFAULT_MESSAGES: Partial<Record<SalesActionFailureReason, string>> = {
  "not-configured": "Sales actions need the engine URL and its action token in Settings.",
  "api-off": "The sales engine has its read API turned off. Set SALES_READ_TOKEN on the engine.",
  "actions-off":
    "The sales engine has its actions turned off. Set SALES_ACTION_TOKEN on the engine, to a value of its own.",
  unreachable: "Could not reach the sales engine. Check the URL and that the engine is up.",
  budget:
    "The engine ran out of requests partway through. Some of the work may be done: look again before retrying.",
};

const unauthorisedMessage = (half: Half) =>
  half === "read"
    ? "The sales engine refused the read token. Check that it matches SALES_READ_TOKEN on the engine."
    : "The sales engine refused the action token. Check that it matches SALES_ACTION_TOKEN on the engine.";

export const salesActionError = (
  reason: SalesActionFailureReason,
  extra: { readonly message?: string; readonly currentHash?: string | null; state?: string | null },
) =>
  new SalesActionError({
    reason,
    message: extra.message ?? DEFAULT_MESSAGES[reason] ?? "The sales engine refused that.",
    currentHash: extra.currentHash ?? null,
    state: extra.state ?? null,
  });

const ENGINE_REASONS = new Set<string>(SalesActionFailureReasonSchema.literals);

/** The engine's `{ error, message, currentHash, state }`. Anything else reads as no body. */
const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  currentHash: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** An engine refusal as a typed reason. Exported for the tests of the mapping. */
function engineFailure(half: Half, httpStatus: number, body: unknown): SalesActionError {
  const parsed = decodeErrorBody(body);
  const error = parsed._tag === "Some" ? parsed.value : {};
  const code = error.error;
  const extra = {
    ...(error.message === undefined ? {} : { message: error.message }),
    currentHash: error.currentHash ?? null,
    state: error.state ?? null,
  };
  if (httpStatus === 401) {
    return salesActionError("unauthorised", { message: unauthorisedMessage(half) });
  }
  if (code === "sales_api_off") return salesActionError("api-off", {});
  if (code === "sales_actions_off") return salesActionError("actions-off", {});
  if (code === "budget") return salesActionError("budget", extra);
  // Phoenix's own reasons are kebab-case, so an engine code can never collide with one.
  if (code !== undefined && /^[a-z_]+$/u.test(code)) {
    return salesActionError(
      ENGINE_REASONS.has(code) ? (code as SalesActionFailureReason) : "other",
      {
        ...extra,
        message: extra.message ?? `The sales engine refused that (${code}).`,
      },
    );
  }
  return salesActionError("failed", { message: `The sales engine answered HTTP ${httpStatus}.` });
}

const request = Effect.fn("SalesEngineApi.request")(function* <A>(
  config: SalesEngineConfig,
  input: {
    readonly half: Half;
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    /** A decoder compiled once at module scope. */
    readonly decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>;
  },
) {
  const client = yield* HttpClient.HttpClient;
  const base = salesApiBaseUrl(config.baseUrl);
  const token = input.half === "read" ? config.readToken : config.actionToken;
  if (config.baseUrl.length === 0) return yield* salesActionError("not-configured", {});
  if (base === null) {
    return yield* salesActionError("failed", {
      message: "The sales engine URL must be an http or https URL.",
    });
  }
  if (token.length === 0) {
    return yield* salesActionError("not-configured", {
      message:
        input.half === "read"
          ? "Sales needs the engine's read token in Settings."
          : "Sales actions need the engine's action token in Settings.",
    });
  }
  const url = `${base}${input.path}`;
  const unsigned =
    input.method === "GET"
      ? HttpClientRequest.get(url)
      : input.method === "DELETE"
        ? HttpClientRequest.delete(url)
        : HttpClientRequest.post(url);
  const prepared = unsigned.pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.acceptJson,
    (req) => (input.body === undefined ? req : HttpClientRequest.bodyJsonUnsafe(req, input.body)),
  );
  const response = yield* client.execute(prepared).pipe(
    Effect.timeout(input.half === "read" ? READ_TIMEOUT : ACTION_TIMEOUT),
    Effect.mapError(() => salesActionError("unreachable", {})),
  );
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  if (response.status < 200 || response.status >= 300) {
    return yield* engineFailure(input.half, response.status, json);
  }
  return yield* input.decode(json).pipe(
    Effect.mapError(() =>
      salesActionError("failed", {
        message: "The sales engine sent an answer Phoenix could not read.",
      }),
    ),
  );
});

const path = (template: string, id: string) => `${template}/${encodeURIComponent(id)}`;

const decodeSummary = Schema.decodeUnknownEffect(SalesSummary);
const decodeQueue = Schema.decodeUnknownEffect(SalesQueue);
const decodeQueueItem = Schema.decodeUnknownEffect(Schema.Struct({ item: SalesQueueItemDetail }));
const decodeConversations = Schema.decodeUnknownEffect(SalesConversationList);
const decodeConversation = Schema.decodeUnknownEffect(SalesConversationDetail);
const decodeDevices = Schema.decodeUnknownEffect(SalesDeviceList);
const decodeDevice = Schema.decodeUnknownEffect(Schema.Struct({ device: SalesDevice }));

// --- The views (read token) -------------------------------------------------------------------

export const readSummary = (config: SalesEngineConfig) =>
  request(config, { half: "read", method: "GET", path: "/summary", decode: decodeSummary });

export const readQueue = (config: SalesEngineConfig) =>
  request(config, { half: "read", method: "GET", path: "/queue", decode: decodeQueue });

export const readQueueItem = (config: SalesEngineConfig, activityId: string) =>
  request(config, {
    half: "read",
    method: "GET",
    path: path("/queue", activityId),
    decode: decodeQueueItem,
  }).pipe(Effect.map((body) => body.item));

export const readConversations = (config: SalesEngineConfig) =>
  request(config, {
    half: "read",
    method: "GET",
    path: "/conversations",
    decode: decodeConversations,
  });

export const readConversation = (config: SalesEngineConfig, contactKey: string) =>
  request(config, {
    half: "read",
    method: "GET",
    path: path("/conversations", contactKey),
    decode: decodeConversation,
  });

// --- Actions and devices (action token) -------------------------------------------------------

export const listDevices = (config: SalesEngineConfig) =>
  request(config, { half: "action", method: "GET", path: "/devices", decode: decodeDevices });

export const enrolDevice = (config: SalesEngineConfig, input: SalesEnrolDeviceInput) =>
  request(config, {
    half: "action",
    method: "POST",
    path: "/devices",
    body: input,
    decode: decodeDevice,
  }).pipe(Effect.map((body) => body.device));

export const revokeDevice = (config: SalesEngineConfig, deviceId: string) =>
  request(config, {
    half: "action",
    method: "DELETE",
    path: path("/devices", deviceId),
    decode: decodeDevice,
  }).pipe(Effect.map((body) => body.device));

/** The engine's answer per item: a card as it now stands, or why it was turned away. */
const EngineApproveItem = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    already: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    ...SalesCardState.fields,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    activityId: Schema.String,
    reason: Schema.String,
    message: Schema.optional(Schema.String),
    currentHash: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);
const APPROVE_REASONS = new Set<string>(SalesApproveFailureReason.literals);
const decodeApprove = Schema.decodeUnknownEffect(
  Schema.Struct({ results: Schema.Array(EngineApproveItem) }),
);

/**
 * Relays signed presses exactly as the device made them. Nothing here can make or change a
 * signature: the server holds no device key. Results come back in the items' order; an item
 * the engine did not answer reads as failed rather than approved.
 */
export const approve = Effect.fn("SalesEngineApi.approve")(function* (
  config: SalesEngineConfig,
  input: SalesApproveInput,
) {
  const body = yield* request(config, {
    half: "action",
    method: "POST",
    path: "/actions/approve",
    body: { items: input.items },
    decode: decodeApprove,
  });
  return input.items.map((item, index): SalesApproveItemResult => {
    const result = body.results[index];
    if (result === undefined || result.activityId !== item.activityId) {
      return {
        ok: false,
        activityId: item.activityId,
        reason: "other",
        message: "The sales engine did not answer for this draft. Look at it again.",
        currentHash: null,
      };
    }
    if (result.ok) {
      const { ok: _ok, already, ...card } = result;
      return { ok: true, already, card };
    }
    return {
      ok: false,
      activityId: result.activityId,
      reason: APPROVE_REASONS.has(result.reason)
        ? (result.reason as typeof SalesApproveFailureReason.Type)
        : "other",
      message: result.message ?? `The sales engine refused it (${result.reason}).`,
      currentHash: result.currentHash ?? null,
    };
  });
});

const CardAnswer = Schema.Struct({ ok: Schema.Literal(true), ...SalesCardState.fields });
const decodeCard = Schema.decodeUnknownEffect(CardAnswer);
const decodeEdit = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...CardAnswer.fields,
    approvalLapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
);

export const unapprove = (config: SalesEngineConfig, activityId: string) =>
  request(config, {
    half: "action",
    method: "POST",
    path: "/actions/unapprove",
    body: { activityId },
    decode: decodeCard,
  }).pipe(Effect.map(({ ok: _ok, ...card }) => card));

export const edit = (config: SalesEngineConfig, input: SalesEditInput) =>
  request(config, {
    half: "action",
    method: "POST",
    path: "/actions/edit",
    body: input,
    decode: decodeEdit,
  }).pipe(Effect.map(({ ok: _ok, approvalLapsed, ...card }) => ({ card, approvalLapsed })));

export const discard = (
  config: SalesEngineConfig,
  input: { readonly activityId: string; readonly expectedHash: string },
) =>
  request(config, {
    half: "action",
    method: "POST",
    path: "/actions/discard",
    body: input,
    decode: decodeCard,
  }).pipe(Effect.map(({ ok: _ok, ...card }) => card));
