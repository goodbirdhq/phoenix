import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PhoenixCloudAccount from "./PhoenixCloudAccount.ts";

const origin = "https://cloud.example.test";
const current = {
  installation: {
    id: "cloud-id",
    installationId: "local-id",
    name: "Work machine",
    kind: "remote-server",
    lastSeenAt: null,
  },
  user: { id: "user-id", email: "user@example.test", name: "User" },
};
const tokens = { access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 };
const device = {
  device_code: "private-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: `${origin}/device`,
  expires_in: 600,
  interval: 5,
};

const fixture = (
  options: {
    readonly device?: typeof device;
    readonly tokenReplies?: Array<{ status: number; body: unknown }>;
    readonly currentStatus?: number;
    readonly currentBody?: unknown;
    readonly disconnectStatus?: number;
    readonly currentReady?: Deferred.Deferred<void>;
    readonly currentRelease?: Deferred.Deferred<void>;
    readonly disconnectReady?: Deferred.Deferred<void>;
    readonly disconnectRelease?: Deferred.Deferred<void>;
    readonly mode?: "desktop" | "web";
  } = {},
) => {
  const stored = new Map<string, Uint8Array>();
  const requests: Array<{ url: string; body: string }> = [];
  const replies = [...(options.tokenReplies ?? [{ status: 200, body: tokens }])];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push({
        url: request.url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      const reply = request.url.endsWith("/register")
        ? { status: 200, body: { client_id: "client-id", installation_id: "cloud-id" } }
        : request.url.endsWith("/device/code")
          ? { status: 200, body: options.device ?? device }
          : request.url.endsWith("/oauth2/token")
            ? (replies.shift() ?? { status: 400, body: { error: "authorization_pending" } })
            : request.url.endsWith("/disconnect")
              ? {
                  status:
                    request.headers["content-type"] === "application/json"
                      ? (options.disconnectStatus ?? 204)
                      : 415,
                  body: null,
                }
              : { status: options.currentStatus ?? 200, body: options.currentBody ?? current };
      if (request.url.endsWith("/current")) {
        if (options.currentReady) yield* Deferred.succeed(options.currentReady, undefined);
        if (options.currentRelease) yield* Deferred.await(options.currentRelease);
      }
      if (request.url.endsWith("/disconnect")) {
        if (options.disconnectReady) yield* Deferred.succeed(options.disconnectReady, undefined);
        if (options.disconnectRelease) yield* Deferred.await(options.disconnectRelease);
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(stored.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          stored.set(key, value);
        }),
      create: (key, value) =>
        Effect.sync(() => {
          stored.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          stored.delete(key);
        }),
      getOrCreateRandom: (key, count) =>
        Effect.sync(() => {
          const value = stored.get(key) ?? new Uint8Array(count).fill(1);
          stored.set(key, value);
          return value;
        }),
    }),
  );
  const layer = PhoenixCloudAccount.layer.pipe(
    Layer.provide(secrets),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, mode: options.mode ?? "web" };
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "phoenix-cloud-account-test-" }),
        ),
      ),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provide(NodeServices.layer),
  );
  return { stored, requests, layer };
};

const login = Effect.fn("test.cloud.login")(function* (
  account: PhoenixCloudAccount.PhoenixCloudAccount["Service"],
) {
  const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Work machine" });
  const fiber = yield* account.completeSignIn(attempt).pipe(Effect.forkChild);
  yield* TestClock.adjust("5 seconds");
  return yield* Fiber.join(fiber);
});

it.effect(
  "registers the server kind, saves only after approval, and revokes before removing credentials",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
      assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
      const status = yield* login(account);
      assert.equal(status.state, "signed-in");
      assert.include(test.requests[0]!.body, '"kind":"remote-server"');
      assert.include(
        test.requests[0]!.body,
        '"installation_id":"01010101-0101-4101-8101-010101010101"',
      );
      assert.isTrue(test.stored.has("phoenix-cloud-installation"));
      assert.notInclude(JSON.stringify(status), "access-token");
      yield* account.signOut();
      assert.isFalse(test.stored.has("phoenix-cloud-installation"));
      assert.isTrue(test.requests.some(({ url }) => url.endsWith("/disconnect")));
      assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("cancellation prevents a pending completion from saving credentials", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Server" });
    const started = yield* Deferred.make<void>();
    const completion = yield* Deferred.succeed(started, undefined).pipe(
      Effect.andThen(account.completeSignIn(attempt)),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* account.cancelSignIn(attempt);
    const error = yield* Fiber.join(completion).pipe(Effect.flip);
    assert.equal(error.reason, "cancelled");
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("expires without sending a token request after the deadline", () => {
  const test = fixture({ device: { ...device, expires_in: 2 } });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Server" });
    const completion = yield* account.completeSignIn(attempt).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    assert.equal((yield* Fiber.join(completion).pipe(Effect.flip)).reason, "expired");
    assert.isFalse(test.requests.some(({ url }) => url.endsWith("/oauth2/token")));
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects a verification URL on a different origin", () => {
  const test = fixture({
    device: { ...device, verification_uri: "https://untrusted.example.test/device" },
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    assert.equal(
      (yield* account.beginSignIn({ cloudUrl: origin, name: "Server" }).pipe(Effect.flip)).reason,
      "protocol",
    );
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps credentials when remote revocation fails so logout can be retried", () => {
  const test = fixture({ disconnectStatus: 503 });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    assert.equal((yield* account.signOut().pipe(Effect.flip)).reason, "network");
    assert.isTrue(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("refreshes once for concurrent status calls and saves the rotated token", () => {
  const test = fixture({
    tokenReplies: [
      { status: 200, body: { ...tokens, expires_in: 1 } },
      {
        status: 200,
        body: { ...tokens, access_token: "rotated-access", refresh_token: "rotated-refresh" },
      },
    ],
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    const results = yield* Effect.all(
      [account.status({ refresh: true }), account.status({ refresh: true })],
      {
        concurrency: "unbounded",
      },
    );
    assert.isTrue(results.every((result) => result.state === "signed-in"));
    assert.equal(
      test.requests.filter(({ body }) => body.includes("grant_type=refresh_token")).length,
      1,
    );
    assert.include(
      new TextDecoder().decode(test.stored.get("phoenix-cloud-installation")),
      "rotated-refresh",
    );
  }).pipe(Effect.provide(test.layer));
});

it.effect("treats a revoked refresh grant as signed out", () => {
  const test = fixture({
    tokenReplies: [
      { status: 200, body: { ...tokens, expires_in: 1 } },
      { status: 400, body: { error: "invalid_grant" } },
    ],
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("reports a status network failure without removing the stored account", () => {
  const options = { currentStatus: 200 };
  const test = fixture(options);
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    options.currentStatus = 503;
    assert.deepEqual(yield* account.status({ refresh: true }), { state: "unavailable" });
    assert.isTrue(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("loads the same persisted account in a reconstructed service", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    const restored = yield* Effect.gen(function* () {
      return yield* (yield* PhoenixCloudAccount.PhoenixCloudAccount).status();
    }).pipe(Effect.provide(Layer.fresh(test.layer)));
    assert.equal(restored.state, "signed-in");
  }).pipe(Effect.provide(test.layer));
});

it.effect("handles approval denial without saving a credential", () => {
  const test = fixture({ tokenReplies: [{ status: 400, body: { error: "access_denied" } }] });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    assert.equal((yield* login(account).pipe(Effect.flip)).reason, "denied");
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("honors pending and slow_down before accepting approval", () => {
  const test = fixture({
    tokenReplies: [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: tokens },
    ],
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Server" });
    const completion = yield* account.completeSignIn(attempt).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    yield* TestClock.adjust("5 seconds");
    assert.equal(test.requests.filter(({ url }) => url.endsWith("/oauth2/token")).length, 2);
    yield* TestClock.adjust("5 seconds");
    assert.equal(test.requests.filter(({ url }) => url.endsWith("/oauth2/token")).length, 2);
    yield* TestClock.adjust("5 seconds");
    assert.equal((yield* Fiber.join(completion)).state, "signed-in");
  }).pipe(Effect.provide(test.layer));
});

it.effect("cancels after a token arrives without allowing late account persistence", () =>
  Effect.gen(function* () {
    const currentReady = yield* Deferred.make<void>();
    const currentRelease = yield* Deferred.make<void>();
    const test = fixture({ currentReady, currentRelease });
    yield* Effect.gen(function* () {
      const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
      const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Server" });
      const completion = yield* account.completeSignIn(attempt).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(currentReady);
      yield* account.cancelSignIn(attempt);
      yield* Deferred.succeed(currentRelease, undefined);
      assert.equal((yield* Fiber.join(completion).pipe(Effect.flip)).reason, "cancelled");
      assert.isFalse(test.stored.has("phoenix-cloud-installation"));
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("uses the trusted desktop server mode when a browser starts sign-in", () => {
  const test = fixture({ mode: "desktop" });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const attempt = yield* account.beginSignIn({ cloudUrl: origin, name: "Desktop" });
    assert.include(test.requests[0]!.body, '"kind":"desktop"');
    assert.notInclude(JSON.stringify(attempt), "private-device-code");
    yield* account.cancelSignIn(attempt);
  }).pipe(Effect.provide(test.layer));
});

it.effect("clears a revoked installation on the custom Better Auth 401 response", () => {
  const options = { currentStatus: 200, currentBody: current as unknown };
  const test = fixture(options);
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    options.currentStatus = 401;
    options.currentBody = { code: "UNAUTHORIZED", message: "Installation revoked" };
    assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
    assert.isFalse(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("preserves credentials when refresh is rate limited", () => {
  const test = fixture({
    tokenReplies: [
      { status: 200, body: { ...tokens, expires_in: 1 } },
      { status: 429, body: { code: "TOO_MANY_REQUESTS", message: "Try again later" } },
    ],
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    assert.deepEqual(yield* account.status({ refresh: true }), { state: "unavailable" });
    assert.isTrue(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects an 81-character installation name before making requests", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const error = yield* account
      .beginSignIn({ cloudUrl: origin, name: "x".repeat(81) })
      .pipe(Effect.flip);
    assert.equal(error.reason, "installation-name");
    assert.equal(test.requests.length, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "persists reduced OAuth grants from approval and refresh without inventing scopes",
  () => {
    const test = fixture({
      tokenReplies: [
        { status: 200, body: { ...tokens, scope: "installation", expires_in: 1 } },
        { status: 200, body: { ...tokens, scope: "" } },
      ],
    });
    return Effect.gen(function* () {
      const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
      const initial = yield* login(account);
      assert.equal(initial.state, "signed-in");
      if (initial.state === "signed-in") assert.deepEqual(initial.scopes, ["installation"]);
      const refreshed = yield* account.status({ refresh: true });
      assert.equal(refreshed.state, "signed-in");
      if (refreshed.state === "signed-in") assert.deepEqual(refreshed.scopes, []);
      const restored = yield* Effect.gen(function* () {
        return yield* (yield* PhoenixCloudAccount.PhoenixCloudAccount).status();
      }).pipe(Effect.provide(Layer.fresh(test.layer)));
      assert.equal(restored.state, "signed-in");
      if (restored.state === "signed-in") assert.deepEqual(restored.scopes, []);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("retains previously granted scopes when refresh omits scope", () => {
  const test = fixture({
    tokenReplies: [
      { status: 200, body: { ...tokens, scope: "installation", expires_in: 1 } },
      { status: 200, body: tokens },
    ],
  });
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    const refreshed = yield* account.status({ refresh: true });
    assert.equal(refreshed.state, "signed-in");
    if (refreshed.state === "signed-in") assert.deepEqual(refreshed.scopes, ["installation"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("serves cached status without requests and rechecks ownership every minute", () => {
  const options = { currentStatus: 200 };
  const test = fixture(options);
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    const before = test.requests.length;
    yield* Effect.all(Array.from({ length: 10 }, () => account.status()));
    assert.equal(test.requests.length, before);
    options.currentStatus = 503;
    yield* TestClock.adjust("60 seconds");
    assert.deepEqual(yield* account.status(), { state: "unavailable" });
    assert.isTrue(test.stored.has("phoenix-cloud-installation"));
    options.currentStatus = 200;
    assert.equal((yield* account.status({ refresh: true })).state, "signed-in");
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "keeps failed logout locked across reconstruction and retries disconnect before linking",
  () => {
    const options = { disconnectStatus: 503 };
    const test = fixture(options);
    return Effect.gen(function* () {
      const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
      yield* login(account);
      yield* account.signOut().pipe(Effect.flip);
      assert.deepEqual(yield* account.status(), { state: "signed-out" });
      assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
      yield* Effect.gen(function* () {
        const restored = yield* PhoenixCloudAccount.PhoenixCloudAccount;
        assert.deepEqual(yield* restored.status(), { state: "signed-out" });
        assert.equal(
          (yield* restored.beginSignIn({ cloudUrl: origin, name: "Server" }).pipe(Effect.flip))
            .reason,
          "network",
        );
        assert.isTrue(test.stored.has("phoenix-cloud-installation"));
        options.disconnectStatus = 401;
        const attempt = yield* restored.beginSignIn({ cloudUrl: origin, name: "Server" });
        assert.deepEqual(yield* restored.status(), { state: "signed-out" });
        assert.isFalse(test.stored.has("phoenix-cloud-installation"));
        yield* restored.cancelSignIn(attempt);
      }).pipe(Effect.provide(Layer.fresh(test.layer)));
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("coalesces concurrent explicit verification requests", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    yield* login(account);
    const before = test.requests.length;
    yield* Effect.all(
      Array.from({ length: 10 }, () => account.status({ refresh: true })),
      { concurrency: "unbounded" },
    );
    assert.equal(test.requests.length, before + 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "locks immediately while remote logout is pending and preserves the lock on failure",
  () =>
    Effect.gen(function* () {
      const disconnectReady = yield* Deferred.make<void>();
      const disconnectRelease = yield* Deferred.make<void>();
      const test = fixture({ disconnectStatus: 503, disconnectReady, disconnectRelease });
      yield* Effect.gen(function* () {
        const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
        yield* login(account);
        const logout = yield* account.signOut().pipe(Effect.forkChild);
        yield* Deferred.await(disconnectReady);
        assert.deepEqual(yield* account.status(), { state: "signed-out" });
        assert.isTrue(test.stored.has("phoenix-cloud-signed-out"));
        yield* Deferred.succeed(disconnectRelease, undefined);
        assert.equal((yield* Fiber.join(logout).pipe(Effect.flip)).reason, "network");
        assert.deepEqual(yield* account.status({ refresh: true }), { state: "signed-out" });
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each([204, 503])(
  "observes fresh approval from another service after local logout (%s)",
  (disconnectStatus) => {
    const options = {
      disconnectStatus,
      tokenReplies: [
        { status: 200, body: tokens },
        { status: 200, body: tokens },
      ],
    };
    const test = fixture(options);
    return Effect.gen(function* () {
      const runningServer = yield* PhoenixCloudAccount.PhoenixCloudAccount;
      yield* login(runningServer);
      yield* runningServer.signOut().pipe(Effect.ignore);
      assert.deepEqual(yield* runningServer.status(), { state: "signed-out" });
      options.disconnectStatus = 204;
      yield* Effect.gen(function* () {
        const cli = yield* PhoenixCloudAccount.PhoenixCloudAccount;
        assert.equal((yield* login(cli)).state, "signed-in");
      }).pipe(Effect.provide(Layer.fresh(test.layer)));
      assert.isFalse(test.stored.has("phoenix-cloud-signed-out"));
      assert.equal((yield* runningServer.status({ refresh: true })).state, "signed-in");
    }).pipe(Effect.provide(test.layer));
  },
);
