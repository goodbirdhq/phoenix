import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
}): ServerSelfUpdateCapability | null {
  return input.desktopManaged ? ("desktop-managed" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (_input, _reportProgress = () => Effect.void) {
    return yield* new ServerSelfUpdateError({
      reason:
        serverConfig.mode === "desktop"
          ? "This server is managed by the Phoenix desktop app on its machine; update the desktop app to update it."
          : "Phoenix server self-update is unavailable until Phoenix has an owned package distribution. Build and relaunch Phoenix from source on the server machine.",
    });
  });

  return ServerSelfUpdate.of({ update });
});

export const layer = Layer.effect(ServerSelfUpdate, make());
