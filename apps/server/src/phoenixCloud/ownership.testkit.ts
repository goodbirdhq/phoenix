import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PhoenixCloudAccount from "./PhoenixCloudAccount.ts";

export const signedInStatus = {
  state: "signed-in",
  cloudUrl: "https://cloud.example.test",
  account: { id: "owner", email: "owner@example.test", name: "Owner" },
  installation: { id: "installation", name: "Test", kind: "remote-server" },
  scopes: ["installation"],
  expiresAt: "2099-01-01T00:00:00.000Z",
} as const;

export const layer = Layer.mock(PhoenixCloudAccount.PhoenixCloudAccount)({
  status: () => Effect.succeed(signedInStatus),
});
