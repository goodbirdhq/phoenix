// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Real loopback listener verifies trusted-renderer ownership and disposal.
import * as NodeEvents from "node:events";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { ElectronShell } from "../../electron/ElectronShell.ts";
import { DesktopIpc, type DesktopIpcMethod } from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";
import { installPhoenixCloudAuth } from "./phoenixCloudAuth.ts";

it.live(
  "requires the trusted main renderer and closes its prepared listener when that window closes",
  () => {
    const handlers = new Map<string, DesktopIpcMethod<Error, never>>();
    let rendererUrl = "https://foreign.example/";
    const webContents = Object.assign(new NodeEvents.EventEmitter(), {
      id: 7,
      getURL: () => rendererUrl,
    });
    const window = Object.assign(new NodeEvents.EventEmitter(), {
      webContents,
      isDestroyed: () => false,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* installPhoenixCloudAuth();
        const prepare = handlers.get(Channels.PREPARE_PHOENIX_CLOUD_CALLBACK_CHANNEL)!;
        expect((yield* Effect.exit(prepare.handler(undefined, { sender: { id: 8 } })))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.exit(prepare.handler(undefined, { sender: { id: 7 } })))._tag).toBe(
          "Failure",
        );
        rendererUrl = "phoenix://app/#/original/thread";
        const returnUrl = yield* prepare.handler(undefined, { sender: { id: 7 } });
        expect(typeof returnUrl).toBe("string");
        if (typeof returnUrl !== "string") return yield* Effect.die("missing callback URI");
        yield* Effect.promise(async () => {
          expect((await fetch(returnUrl)).status).toBe(400);
        });
        window.emit("closed");
        yield* Effect.promise(async () => {
          await expect(fetch(returnUrl)).rejects.toThrow();
        });
      }),
    ).pipe(
      Effect.provideService(DesktopIpc, {
        handle: (method) =>
          Effect.sync(() => {
            handlers.set(method.channel, method as unknown as DesktopIpcMethod<Error, never>);
          }),
        handleSync: () => Effect.void,
      } satisfies DesktopIpc["Service"]),
      Effect.provideService(ElectronWindow, {
        main: Effect.succeedSome(window),
      } as unknown as ElectronWindow["Service"]),
      Effect.provideService(ElectronShell, {} as ElectronShell["Service"]),
      Effect.provideService(DesktopEnvironment, {
        isDevelopment: false,
        devServerUrl: Option.none(),
      } as DesktopEnvironment["Service"]),
    );
  },
);
