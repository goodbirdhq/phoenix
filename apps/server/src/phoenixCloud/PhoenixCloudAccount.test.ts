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
              ? { status: options.disconnectStatus ?? 204, body: null }
              : { status: options.currentStatus ?? 200, body: options.currentBody ?? current };
      if (request.url.endsWith("/current")) {
        if (options.currentReady) yield* Deferred.succeed(options.currentReady, undefined);
        if (options.currentRelease) yield* Deferred.await(options.currentRelease);
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
      assert.deepEqual(yield* account.status(), { state: "signed-out" });
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
      assert.deepEqual(yield* account.status(), { state: "signed-out" });
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
    const results = yield* Effect.all([account.status(), account.status()], {
      concurrency: "unbounded",
    });
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
    assert.deepEqual(yield* account.status(), { state: "signed-out" });
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
    assert.equal((yield* account.status().pipe(Effect.flip)).reason, "network");
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
    assert.deepEqual(yield* account.status(), { state: "signed-out" });
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
    assert.equal((yield* account.status().pipe(Effect.flip)).reason, "network");
    assert.isTrue(test.stored.has("phoenix-cloud-installation"));
  }).pipe(Effect.provide(test.layer));
});
