import * as Effect from "effect/Effect";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** Historical cloud link credentials must never reactivate on an upgraded install. */
export const retireManagedConnections = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  for (const name of [
    "cloud-cli-desired-link",
    "cloud-linked-user-id",
    "cloud-relay-url",
    "cloud-relay-issuer",
    "cloud-relay-environment-credential",
    "cloud-mint-ed25519-public-key",
    "cloud-endpoint-runtime-config",
    "cloud-publish-agent-activity",
    "cloud-cli-oauth-token",
  ])
    yield* secrets.remove(name);
});
