import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("direct"),
  connectionId: "direct",
  label: "Direct",
});
const prepared: PreparedConnection = {
  target,
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: "http://100.64.0.2:3773",
  socketUrl: "ws://100.64.0.2:3773/ws",
  httpAuthorization: { _tag: "Bearer", token: "paired-token" },
};
const state = {
  authenticated: false,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
};
describe("direct environment HTTP authorization", () => {
  it.effect("sends the paired bearer token over direct HTTP without cloud services", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(state);
      };
      const result = yield* fetchEnvironmentSessionState({ prepared }).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
      );
      expect(result.authenticated).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://100.64.0.2:3773/api/auth/session");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer paired-token");
    }),
  );
  it.effect("includes cookies for primary connections", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(state);
      };
      yield* fetchEnvironmentSessionState({
        prepared: { ...prepared, httpAuthorization: null },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(requests[0]?.credentials).toBe("include");
      expect(requests[0]?.headers.has("authorization")).toBe(false);
    }),
  );
  it.effect("rejects retired managed credentials before any network request", () =>
    Effect.gen(function* () {
      const fetchFn: typeof fetch = () => {
        throw new Error("must not send retired credentials");
      };
      const failure = yield* fetchEnvironmentSessionState({
        prepared: {
          ...prepared,
          target: new RelayConnectionTarget({
            environmentId: target.environmentId,
            label: "Legacy",
          }),
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "retired",
            expiresAtEpochMs: 99999999999,
          },
        },
      }).pipe(Effect.flip, Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(failure).toMatchObject({ _tag: "RemoteEnvironmentAuthFetchError" });
      expect(failure.message).toContain("no longer supported");
    }),
  );
});
