import { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { executeAuthAccessAction } from "./auth.ts";
import * as DateTime from "effect/DateTime";

import { applyAuthAccessStreamEvent, EMPTY_AUTH_ACCESS_SNAPSHOT } from "./auth.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        pairingLinks: [
          {
            id: "pairing-link",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual(EMPTY_AUTH_ACCESS_SNAPSHOT);
  });
});

describe("environment access actions", () => {
  it.effect("creates a link on the selected remote with its bearer credential and scopes", () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchFn: typeof fetch = (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return Promise.resolve(
          Response.json({
            id: "new-link",
            credential: "test-pairing-code",
            expiresAt: "2036-04-07T00:05:00.000Z",
          }),
        );
      };
      const target = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("remote-test"),
        connectionId: "remote-connection",
        label: "Remote test",
      });
      const result = yield* executeAuthAccessAction(
        {
          environmentId: target.environmentId,
          target,
          label: target.label,
          httpBaseUrl: "https://selected.example",
          socketUrl: "wss://selected.example/ws",
          httpAuthorization: { _tag: "Bearer", token: "remote-test-token" },
        },
        { kind: "create", label: "Tablet", scopes: ["orchestration:read"] },
      ).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://selected.example/api/auth/pairing-token");
      expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
        "Bearer remote-test-token",
      );
      expect(calls[0]?.init.method).toBe("POST");
      expect(yield* Effect.promise(() => new Response(calls[0]?.init.body).json())).toEqual({
        label: "Tablet",
        scopes: ["orchestration:read"],
      });
      expect(result).toMatchObject({ id: "new-link", credential: "test-pairing-code" });
    }),
  );

  it.effect("uses cookies for the selected primary and preserves mutation failure", () =>
    Effect.gen(function* () {
      let credentials: RequestCredentials | undefined;
      const fetchFn: typeof fetch = (_input, init) => {
        credentials = init?.credentials;
        return Promise.resolve(new Response("Denied", { status: 403 }));
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("primary-test"),
        label: "Test",
        httpBaseUrl: "http://localhost:1234",
        wsBaseUrl: "ws://localhost:1234",
      });
      const result = yield* Effect.exit(
        executeAuthAccessAction(
          {
            environmentId: target.environmentId,
            target,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: target.wsBaseUrl,
            httpAuthorization: null,
          },
          { kind: "revokeOthers" },
        ).pipe(Effect.provide(remoteHttpClientLayer(fetchFn))),
      );
      expect(credentials).toBe("include");
      expect(result._tag).toBe("Failure");
    }),
  );
});
