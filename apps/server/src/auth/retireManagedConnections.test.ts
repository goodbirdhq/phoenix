import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { retireManagedConnections } from "./retireManagedConnections.ts";
it.layer(NodeServices.layer)("managed secret retirement", (it) => {
  it.effect(
    "clears legacy cloud state idempotently and preserves direct and provider secrets",
    () =>
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const bytes = new TextEncoder().encode("secret-value");
        for (const name of [
          "cloud-cli-desired-link",
          "cloud-cli-oauth-token",
          "cloud-relay-environment-credential",
          "session-signing-key",
          "provider-oauth-token",
        ])
          yield* secrets.set(name, bytes);
        yield* retireManagedConnections;
        yield* retireManagedConnections;
        for (const name of [
          "cloud-cli-desired-link",
          "cloud-cli-oauth-token",
          "cloud-relay-environment-credential",
        ])
          expect(Option.isNone(yield* secrets.get(name))).toBe(true);
        for (const name of ["session-signing-key", "provider-oauth-token"])
          expect(Option.getOrThrow(yield* secrets.get(name))).toEqual(bytes);
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "retire-managed-" })),
          ),
        ),
      ),
  );
});
