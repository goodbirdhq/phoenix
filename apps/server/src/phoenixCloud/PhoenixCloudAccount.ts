import {
  PhoenixCloudAccountError,
  PhoenixCloudAccountStatus,
  type PhoenixCloudSignInAttempt,
  PhoenixCloudSignInInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { CloudOriginError, normalizeCloudOrigin } from "./config.ts";

const SECRET = "phoenix-cloud-installation";
const Credential = Schema.Struct({
  cloudUrl: Schema.String,
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Credential = typeof Credential.Type;
const CredentialJson = Schema.fromJsonString(Credential);
const decodeCredential = Schema.decodeEffect(CredentialJson);
const encodeCredential = Schema.encodeEffect(CredentialJson);
const isCloudOriginError = Schema.is(CloudOriginError);
const decodeInstallationName = Schema.decodeEffect(PhoenixCloudSignInInput.fields.name);
const grantedScopes = (scope: string) => scope.split(/\s+/).filter(Boolean);
const Registration = Schema.Struct({ client_id: Schema.String, installation_id: Schema.String });
const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  interval: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
});
const Tokens = Schema.Struct({
  scope: Schema.optionalKey(Schema.String),
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const Current = Schema.Struct({
  installation: Schema.Struct({
    id: Schema.String,
    installationId: Schema.String,
    name: Schema.String,
    kind: Schema.Literals(["desktop", "remote-server"]),
    lastSeenAt: Schema.NullOr(Schema.String),
  }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
});
const OAuthError = Schema.Struct({ error: Schema.String });

export class PhoenixCloudAccount extends Context.Service<
  PhoenixCloudAccount,
  {
    readonly status: () => Effect.Effect<PhoenixCloudAccountStatus, PhoenixCloudAccountError>;
    readonly beginSignIn: (
      input: PhoenixCloudSignInInput,
    ) => Effect.Effect<PhoenixCloudSignInAttempt, PhoenixCloudAccountError>;
    readonly completeSignIn: (input: {
      readonly attemptId: string;
    }) => Effect.Effect<PhoenixCloudAccountStatus, PhoenixCloudAccountError>;
    readonly cancelSignIn: (input: {
      readonly attemptId: string;
    }) => Effect.Effect<void, PhoenixCloudAccountError>;
    readonly signOut: () => Effect.Effect<void, PhoenixCloudAccountError>;
  }
>()("t3/phoenixCloud/PhoenixCloudAccount") {}

type Attempt = {
  readonly id: string;
  readonly credential: Pick<Credential, "cloudUrl" | "clientId">;
  readonly deviceCode: string;
  readonly expiresAt: number;
  readonly interval: number;
  readonly cancelled: Deferred.Deferred<void>;
  completing: boolean;
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const configuredUrl = yield* Config.String("PHOENIX_CLOUD_URL").pipe(Config.option);
  const allowHttp = yield* Config.String("PHOENIX_CLOUD_ALLOW_INSECURE_HTTP").pipe(
    Config.withDefault("0"),
  );
  const gate = yield* Semaphore.make(1);
  const active = yield* Ref.make<Attempt | null>(null);

  const request = Effect.fn("PhoenixCloudAccount.request")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    return yield* http.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(() => new PhoenixCloudAccountError({ reason: "network" })),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
  });
  const decode =
    <A, I>(schema: Schema.Codec<A, I, never, never>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(
          (cause) =>
            new PhoenixCloudAccountError({
              reason: cause._tag === "TimeoutError" ? "network" : "protocol",
            }),
        ),
      );
  const read = Effect.fn("PhoenixCloudAccount.read")(function* () {
    const bytes = yield* secrets
      .get(SECRET)
      .pipe(Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })));
    if (Option.isNone(bytes)) return null;
    const credential = yield* decodeCredential(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })),
    );
    if (isCloudOriginError(normalizeCloudOrigin(credential.cloudUrl, allowHttp === "1"))) {
      return yield* new PhoenixCloudAccountError({ reason: "configuration" });
    }
    return credential;
  });
  const persist = Effect.fn("PhoenixCloudAccount.persist")(function* (credential: Credential) {
    const json = yield* encodeCredential(credential).pipe(
      Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })),
    );
    yield* secrets
      .set(SECRET, new TextEncoder().encode(json))
      .pipe(Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })));
  });
  const remove = secrets
    .remove(SECRET)
    .pipe(Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })));
  const tokenRequest = (cloudUrl: string, params: Record<string, string>) =>
    request(
      HttpClientRequest.post(`${cloudUrl}/api/auth/oauth2/token`).pipe(
        HttpClientRequest.bodyUrlParams(params),
      ),
    );
  const refresh = Effect.fn("PhoenixCloudAccount.refresh")(function* (credential: Credential) {
    if (credential.expiresAt - 60_000 > (yield* Clock.currentTimeMillis)) return credential;
    const response = yield* tokenRequest(credential.cloudUrl, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
    });
    if ([400, 401, 403].includes(response.status)) {
      const error = yield* decode(OAuthError)(response);
      if (
        ["invalid_grant", "invalid_client", "access_denied", "unauthorized_client"].includes(
          error.error,
        )
      ) {
        yield* remove;
        return null;
      }
    }
    if (response.status !== 200)
      return yield* new PhoenixCloudAccountError({
        reason: response.status === 429 || response.status >= 500 ? "network" : "protocol",
      });
    const tokens = yield* decode(Tokens)(response);
    const updated = {
      ...credential,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
      scopes: tokens.scope === undefined ? (credential.scopes ?? []) : grantedScopes(tokens.scope),
    };
    yield* persist(updated);
    return updated;
  });
  const current = Effect.fn("PhoenixCloudAccount.current")(function* (
    credential: Credential,
  ): Effect.fn.Return<PhoenixCloudAccountStatus, PhoenixCloudAccountError> {
    const response = yield* request(
      HttpClientRequest.get(`${credential.cloudUrl}/api/installations/current`).pipe(
        HttpClientRequest.bearerToken(credential.accessToken),
      ),
    );
    if (response.status === 401) {
      yield* remove;
      return { state: "signed-out" };
    }
    if (response.status !== 200)
      return yield* new PhoenixCloudAccountError({
        reason: response.status === 429 || response.status >= 500 ? "network" : "protocol",
      });
    const value = yield* decode(Current)(response);
    return {
      state: "signed-in",
      cloudUrl: credential.cloudUrl,
      account: value.user,
      installation: value.installation,
      scopes: credential.scopes ?? [],
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(credential.expiresAt)),
    };
  });
  const cancelActive = Effect.fn("PhoenixCloudAccount.cancelActive")(function* () {
    const attempt = yield* Ref.getAndSet(active, null);
    if (attempt) yield* Deferred.succeed(attempt.cancelled, undefined);
  });

  const status = Effect.fn("PhoenixCloudAccount.status")(() =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const saved = yield* read();
        if (!saved) return { state: "signed-out" } as const;
        // Rotation and persistence must finish together; the HTTP exchange has its own timeout.
        const credential = yield* refresh(saved).pipe(Effect.uninterruptible);
        return credential ? yield* current(credential) : ({ state: "signed-out" } as const);
      }),
    ),
  );
  const beginSignIn = Effect.fn("PhoenixCloudAccount.beginSignIn")(
    (input: PhoenixCloudSignInInput) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const name = yield* decodeInstallationName(input.name).pipe(
            Effect.mapError(() => new PhoenixCloudAccountError({ reason: "installation-name" })),
          );
          const previous = yield* Ref.get(active);
          if (previous && previous.expiresAt <= (yield* Clock.currentTimeMillis))
            yield* cancelActive();
          if ((yield* read()) || (yield* Ref.get(active)))
            return yield* new PhoenixCloudAccountError({ reason: "busy" });
          const cloudUrl = normalizeCloudOrigin(
            input.cloudUrl ?? Option.getOrUndefined(configuredUrl),
            allowHttp === "1",
          );
          if (isCloudOriginError(cloudUrl))
            return yield* new PhoenixCloudAccountError({ reason: "configuration" });
          const identity = yield* secrets
            .getOrCreateRandom("phoenix-cloud-installation-id", 16)
            .pipe(Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" })));
          const bytes = Uint8Array.from(identity);
          bytes[6] = (bytes[6]! & 0x0f) | 0x40;
          bytes[8] = (bytes[8]! & 0x3f) | 0x80;
          const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
          const installationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          const registered = yield* request(
            HttpClientRequest.post(`${cloudUrl}/api/installations/register`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                installation_id: installationId,
                name,
                kind: config.mode === "desktop" ? "desktop" : "remote-server",
              }),
            ),
          );
          if (registered.status !== 200 && registered.status !== 201)
            return yield* new PhoenixCloudAccountError({
              reason:
                registered.status === 429 || registered.status >= 500 ? "network" : "protocol",
            });
          const registration = yield* decode(Registration)(registered);
          const response = yield* request(
            HttpClientRequest.post(`${cloudUrl}/api/auth/device/code`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                client_id: registration.client_id,
                scope: "installation offline_access",
              }),
            ),
          );
          if (response.status !== 200)
            return yield* new PhoenixCloudAccountError({
              reason: response.status === 429 || response.status >= 500 ? "network" : "protocol",
            });
          const device = yield* decode(DeviceCode)(response);
          for (const value of [device.verification_uri, device.verification_uri_complete]) {
            if (value === undefined) continue;
            let url: URL;
            try {
              url = new URL(value);
            } catch {
              return yield* new PhoenixCloudAccountError({ reason: "protocol" });
            }
            if (url.origin !== cloudUrl || url.username || url.password)
              return yield* new PhoenixCloudAccountError({ reason: "protocol" });
          }
          const attempt: Attempt = {
            id: yield* crypto
              .randomUUIDv4()
              .pipe(Effect.mapError(() => new PhoenixCloudAccountError({ reason: "storage" }))),
            credential: { cloudUrl, clientId: registration.client_id },
            deviceCode: device.device_code,
            expiresAt: (yield* Clock.currentTimeMillis) + device.expires_in * 1000,
            interval: device.interval ?? 5,
            cancelled: yield* Deferred.make<void>(),
            completing: false,
          };
          yield* Ref.set(active, attempt);
          return {
            attemptId: attempt.id,
            verificationUri: device.verification_uri,
            ...(device.verification_uri_complete
              ? { verificationUriComplete: device.verification_uri_complete }
              : {}),
            userCode: device.user_code,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(attempt.expiresAt)),
            intervalSeconds: attempt.interval,
          };
        }),
      ),
  );
  const cancelSignIn = Effect.fn("PhoenixCloudAccount.cancelSignIn")(
    (input: { readonly attemptId: string }) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(active))?.id === input.attemptId) yield* cancelActive();
        }),
      ),
  );
  const completeSignIn = Effect.fn("PhoenixCloudAccount.completeSignIn")(function* (input: {
    readonly attemptId: string;
  }) {
    const attempt = yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const attempt = yield* Ref.get(active);
        if (!attempt || attempt.id !== input.attemptId)
          return yield* new PhoenixCloudAccountError({ reason: "cancelled" });
        if (attempt.completing) return yield* new PhoenixCloudAccountError({ reason: "busy" });
        attempt.completing = true;
        return attempt;
      }),
    );
    const poll = Effect.gen(function* () {
      let interval = attempt.interval;
      while (true) {
        const remaining = attempt.expiresAt - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) return yield* new PhoenixCloudAccountError({ reason: "expired" });
        yield* Effect.sleep(Math.min(interval * 1000, remaining));
        if ((yield* Clock.currentTimeMillis) >= attempt.expiresAt)
          return yield* new PhoenixCloudAccountError({ reason: "expired" });
        const response = yield* tokenRequest(attempt.credential.cloudUrl, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: attempt.deviceCode,
          client_id: attempt.credential.clientId,
        });
        if (response.status === 200) {
          const tokens = yield* decode(Tokens)(response);
          const credential = {
            ...attempt.credential,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
            scopes: tokens.scope === undefined ? [] : grantedScopes(tokens.scope),
          };
          const result = yield* current(credential);
          if (result.state !== "signed-in")
            return yield* new PhoenixCloudAccountError({ reason: "denied" });
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* Ref.get(active)) !== attempt)
                return yield* new PhoenixCloudAccountError({ reason: "cancelled" });
              yield* persist(credential);
              yield* Ref.set(active, null);
              return result;
            }),
          );
        }
        if (response.status === 429 || response.status >= 500)
          return yield* new PhoenixCloudAccountError({ reason: "network" });
        const error = yield* decode(OAuthError)(response);
        if (error.error === "authorization_pending") continue;
        if (error.error === "slow_down") {
          interval += 5;
          continue;
        }
        return yield* new PhoenixCloudAccountError({
          reason:
            error.error === "expired_token" || error.error === "invalid_grant"
              ? "expired"
              : error.error === "access_denied"
                ? "denied"
                : "protocol",
        });
      }
    });
    const deadline = Effect.sleep(
      Math.max(0, attempt.expiresAt - (yield* Clock.currentTimeMillis)),
    ).pipe(Effect.andThen(new PhoenixCloudAccountError({ reason: "expired" })));
    return yield* Effect.raceFirst(
      Effect.raceFirst(poll, deadline),
      Deferred.await(attempt.cancelled).pipe(
        Effect.andThen(new PhoenixCloudAccountError({ reason: "cancelled" })),
      ),
    ).pipe(Effect.ensuring(cancelSignIn(input)));
  });
  const signOut = Effect.fn("PhoenixCloudAccount.signOut")(() =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        yield* cancelActive();
        const saved = yield* read();
        if (!saved) return;
        const credential = yield* refresh(saved).pipe(Effect.uninterruptible);
        if (!credential) return;
        const response = yield* request(
          HttpClientRequest.post(`${credential.cloudUrl}/api/installations/disconnect`).pipe(
            HttpClientRequest.bearerToken(credential.accessToken),
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        );
        if (![200, 204, 401].includes(response.status))
          return yield* new PhoenixCloudAccountError({ reason: "network" });
        yield* remove;
      }),
    ),
  );
  return PhoenixCloudAccount.of({ status, beginSignIn, completeSignIn, cancelSignIn, signOut });
});

export const layer = Layer.effect(PhoenixCloudAccount, make);
