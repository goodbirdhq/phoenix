import { HttpRouter, HttpServerResponse } from "effect/http";
import { layerHttp } from "./ownership.ts";
import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PhoenixCloudAccount from "./PhoenixCloudAccount.ts";
import {
  ownershipRequiredForHttp,
  ownershipRequiredForRpc,
  requireOwnership,
} from "./ownership.ts";
import * as OwnershipTestkit from "./ownership.testkit.ts";

it.effect.each(["signed-out", "unavailable"] as const)(
  "denies new work when ownership is %s",
  (state) =>
    Effect.gen(function* () {
      const error = yield* requireOwnership().pipe(Effect.flip);
      assert.equal(error.requiredPermission, "phoenix-cloud-ownership");
    }).pipe(
      Effect.provide(
        Layer.mock(PhoenixCloudAccount.PhoenixCloudAccount)({
          status: () => Effect.succeed({ state }),
        }),
      ),
    ),
);
it.effect("allows a verified installation", () =>
  requireOwnership().pipe(Effect.provide(OwnershipTestkit.layer)),
);
it("keeps bootstrap and stop RPCs usable but denies operational RPCs", () => {
  for (const method of [
    WS_METHODS.phoenixCloudStatus,
    WS_METHODS.phoenixCloudBeginSignIn,
    WS_METHODS.phoenixCloudCompleteSignIn,
    WS_METHODS.phoenixCloudCancelSignIn,
    WS_METHODS.phoenixCloudSignOut,
    WS_METHODS.serverProbe,
    WS_METHODS.serverGetConfig,
    WS_METHODS.terminalClose,
  ]) {
    assert.isFalse(ownershipRequiredForRpc(method, {}));
  }
  for (const type of ["thread.stop", "run.interrupt", "queued-run.cancel"]) {
    assert.isFalse(ownershipRequiredForRpc(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, { type }));
  }
  assert.isTrue(
    ownershipRequiredForRpc(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "message.dispatch",
    }),
  );
  assert.isTrue(ownershipRequiredForRpc(WS_METHODS.terminalWrite, {}));
  assert.isTrue(ownershipRequiredForRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, {}));
});
it("keeps transport, pairing and static bootstrap while guarding HTTP and MCP", () => {
  for (const path of [
    "/",
    "/assets/app.js",
    "/ws",
    "/.well-known/t3/environment",
    "/api/auth/session",
    "/api/auth/websocket-ticket",
    "/oauth/token",
  ])
    assert.isFalse(ownershipRequiredForHttp(path));
  for (const path of [
    "/api/projects",
    "/api/orchestration/shell",
    "/api/preview-stream/ws",
    "/api/attachments/upload",
    "/mcp",
    "/mcp/tools",
  ])
    assert.isTrue(ownershipRequiredForHttp(path));
});

it("enforces ownership on HTTP/MCP handlers while keeping authentication bootstrap", async () => {
  const handled: string[] = [];
  const route = (path: "/api/projects" | "/mcp" | "/api/auth/session") =>
    HttpRouter.add(
      "GET",
      path,
      Effect.sync(() => {
        handled.push(path);
        return HttpServerResponse.empty();
      }),
    );
  const routes = Layer.mergeAll(
    route("/api/projects"),
    route("/mcp"),
    route("/api/auth/session"),
  ).pipe(
    Layer.provide(layerHttp),
    Layer.provide(
      Layer.mock(PhoenixCloudAccount.PhoenixCloudAccount)({
        status: () => Effect.succeed({ state: "signed-out" }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    for (const path of ["/api/projects", "/mcp"]) {
      const response = await handler(new Request(`https://server.example${path}`));
      assert.equal(response.status, 403);
      assert.include(await response.text(), "phoenix_cloud_ownership_required");
    }
    assert.equal(
      (await handler(new Request("https://server.example/api/auth/session"))).status,
      204,
    );
    assert.deepEqual(handled, ["/api/auth/session"]);
  } finally {
    await dispose();
  }
});
