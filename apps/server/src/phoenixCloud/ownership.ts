import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  AuthAccessWriteScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PhoenixCloudAccount from "./PhoenixCloudAccount.ts";

// Transport spans cover this admission check, which also runs for each control frame.
export const requireOwnership = Effect.fnUntraced(function* () {
  const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
  const status = yield* account
    .status()
    .pipe(Effect.catch(() => Effect.succeed({ state: "unavailable" } as const)));
  if (status.state !== "signed-in")
    return yield* new EnvironmentAuthorizationError({
      message:
        status.state === "unavailable"
          ? "Phoenix Cloud ownership could not be verified. Retry when Cloud is available."
          : "Link this server installation to Phoenix Cloud in Settings → Connections or run phoenix cloud login before using it.",
      requiredScope: AuthAccessWriteScope,
      requiredPermission: "phoenix-cloud-ownership",
    });
});

const bootstrapMethods = new Set<string>([
  WS_METHODS.phoenixCloudStatus,
  WS_METHODS.phoenixCloudBeginSignIn,
  WS_METHODS.phoenixCloudCompleteSignIn,
  WS_METHODS.phoenixCloudCancelSignIn,
  WS_METHODS.phoenixCloudSignOut,
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeAuthAccess,
  WS_METHODS.terminalClose,
  WS_METHODS.providerAuthCancel,
  WS_METHODS.providerInstallCancel,
  WS_METHODS.worktreeSetupCancel,
  WS_METHODS.projectCloneCancel,
  WS_METHODS.previewClose,
  WS_METHODS.deviceClose,
  ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
]);
const StopCommand = Schema.Struct({
  type: Schema.Literals(["thread.stop", "run.interrupt", "queued-run.cancel", "subagent.stop"]),
});

const isStopCommand = Schema.is(StopCommand);

export const ownershipRequiredForRpc = (method: string, payload: unknown): boolean =>
  !bootstrapMethods.has(method) &&
  !(method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && isStopCommand(payload));

export const ownershipRequiredForHttp = (path: string): boolean =>
  (path.startsWith("/api/") && !path.startsWith("/api/auth/")) ||
  path === "/mcp" ||
  path.startsWith("/mcp/");

export const layerHttp = Layer.unwrap(
  Effect.gen(function* () {
    const account = yield* PhoenixCloudAccount.PhoenixCloudAccount;
    const check = requireOwnership().pipe(
      Effect.provideService(PhoenixCloudAccount.PhoenixCloudAccount, account),
    );
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const path = new URL(request.url, "http://localhost").pathname;
          if (!ownershipRequiredForHttp(path)) return yield* httpEffect;
          const allowed = yield* check.pipe(Effect.result);
          if (allowed._tag === "Failure")
            return HttpServerResponse.jsonUnsafe(
              {
                code: "phoenix_cloud_ownership_required",
                message: allowed.failure.message,
              },
              { status: 403 },
            );
          return yield* httpEffect;
        }),
      { global: true },
    );
  }),
);
