import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { SalesSummary } from "@t3tools/contracts";

/**
 * The adapter for the external sales engine's read API (`/api/sales/v1`, GET only, Bearer
 * token). Everything engine-shaped stays here: the path, the auth header, and how its answers
 * map to a Phoenix status. The contract lives with the engine, in its `docs/sales-api.md`.
 */

const API_PATH = "/api/sales/v1";
const REQUEST_TIMEOUT = "15 seconds";

export interface SalesEngineConfig {
  readonly baseUrl: string;
  readonly readToken: string;
}

/** Why a read did not produce a summary, as the status clients show. */
class SalesEngineReadError extends Schema.TaggedError<SalesEngineReadError>()(
  "SalesEngineReadError",
  {
    status: Schema.Literals(["off", "unauthorised", "unreachable", "failed"]),
    httpStatus: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.status) {
      case "off":
        return "The sales engine has its read API turned off. Set SALES_READ_TOKEN on the engine.";
      case "unauthorised":
        return "The sales engine refused the read token. Check that it matches SALES_READ_TOKEN on the engine.";
      case "unreachable":
        return "Could not reach the sales engine. Check the URL and that the engine is up.";
      case "failed":
        return this.httpStatus === undefined
          ? "The sales engine sent an answer Phoenix could not read."
          : `The sales engine answered HTTP ${this.httpStatus}.`;
    }
  }
}

/**
 * The engine root a user enters, normalised to the API base. Accepts the origin with or
 * without the `/api/sales/v1` suffix and trailing slashes. Null when it is not an http(s) URL.
 */
export function salesApiBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!URL.canParse(trimmed)) return null;
  const protocol = new URL(trimmed).protocol;
  if (protocol !== "https:" && protocol !== "http:") return null;
  return trimmed.endsWith(API_PATH) ? trimmed : `${trimmed}${API_PATH}`;
}

const errorStatusFor = (status: number): SalesEngineReadError["status"] =>
  status === 503 ? "off" : status === 401 ? "unauthorised" : "failed";

const decodeSummary = HttpClientResponse.schemaBodyJson(SalesSummary);

/** Reads `GET /summary`. Requires a config whose URL `salesApiBaseUrl` accepts. */
export const readSummary = Effect.fn("SalesEngineApi.readSummary")(function* (
  config: SalesEngineConfig,
) {
  const client = yield* HttpClient.HttpClient;
  const base = salesApiBaseUrl(config.baseUrl);
  if (base === null) return yield* new SalesEngineReadError({ status: "failed" });
  const response = yield* client
    .execute(
      HttpClientRequest.get(`${base}/summary`).pipe(
        HttpClientRequest.bearerToken(config.readToken),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((cause) => new SalesEngineReadError({ status: "unreachable", cause })),
    );
  if (response.status < 200 || response.status >= 300) {
    // A 503 is only "off" when it says so; anything else at 503 is the engine failing.
    const status = errorStatusFor(response.status);
    if (status === "off") {
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const off =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        body.error === "sales_api_off";
      return yield* new SalesEngineReadError({
        status: off ? "off" : "failed",
        httpStatus: response.status,
      });
    }
    return yield* new SalesEngineReadError({ status, httpStatus: response.status });
  }
  return yield* decodeSummary(response).pipe(
    Effect.mapError((cause) => new SalesEngineReadError({ status: "failed", cause })),
  );
});
