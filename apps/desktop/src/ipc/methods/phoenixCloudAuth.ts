import { preparePhoenixCloudCallback } from "@t3tools/shared/phoenixCloudCallback";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronProtocol from "../../electron/ElectronProtocol.ts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

class PhoenixCloudCallbackError extends Schema.TaggedError<PhoenixCloudCallbackError>()(
  "PhoenixCloudCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const failure = (cause: unknown) =>
  new PhoenixCloudCallbackError({
    detail:
      cause instanceof Error ? cause.message : "Could not finish Phoenix Cloud sign-in. Try again.",
  });
const Request = Schema.String.check(Schema.isMaxLength(16_384));

export const installPhoenixCloudAuth = Effect.fn("desktop.ipc.phoenixCloud.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const windows = yield* ElectronWindow.ElectronWindow;
  const shell = yield* ElectronShell.ElectronShell;
  const environment = yield* DesktopEnvironment;
  const context = yield* Effect.context<ElectronShell.ElectronShell>();
  const runPromise = Effect.runPromiseWith(context);
  const listeners = new Map<
    string,
    {
      ownerId: number;
      listener: Awaited<ReturnType<typeof preparePhoenixCloudCallback>>;
      dispose: () => void;
    }
  >();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of listeners.values()) entry.dispose();
    }),
  );

  const owner = Effect.fn("desktop.ipc.phoenixCloud.owner")(function* (
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const main = yield* windows.main;
    if (
      !event ||
      Option.isNone(main) ||
      main.value.isDestroyed() ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* Effect.fail(
        new PhoenixCloudCallbackError({
          detail: "Phoenix Cloud sign-in requires the main app window.",
        }),
      );
    }
    const trusted = yield* Effect.try({
      try: () => {
        const url = new URL(main.value.webContents.getURL());
        return (
          (url.protocol === `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}:` &&
            url.host === ElectronProtocol.DESKTOP_HOST) ||
          (environment.isDevelopment &&
            Option.isSome(environment.devServerUrl) &&
            url.origin === environment.devServerUrl.value.origin)
        );
      },
      catch: failure,
    });
    if (!trusted)
      return yield* Effect.fail(
        new PhoenixCloudCallbackError({
          detail: "Phoenix Cloud sign-in requires a trusted app renderer.",
        }),
      );
    return main.value;
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.PREPARE_PHOENIX_CLOUD_CALLBACK_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.String,
      handler: Effect.fn("desktop.ipc.phoenixCloud.prepare")(function* (_input, event) {
        const window = yield* owner(event);
        for (const entry of listeners.values())
          if (entry.ownerId === window.webContents.id) entry.dispose();
        const listener = yield* Effect.tryPromise({
          try: preparePhoenixCloudCallback,
          catch: failure,
        });
        const dispose = () => {
          listener.cancel();
          listeners.delete(listener.redirectUri);
          window.removeListener("closed", dispose);
          window.webContents.removeListener("destroyed", dispose);
        };
        listeners.set(listener.redirectUri, { ownerId: window.webContents.id, listener, dispose });
        window.once("closed", dispose);
        window.webContents.once("destroyed", dispose);
        return listener.redirectUri;
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.RECEIVE_PHOENIX_CLOUD_CALLBACK_CHANNEL,
      payload: Request,
      result: Schema.String,
      handler: Effect.fn("desktop.ipc.phoenixCloud.receive")(function* (authorizationUrl, event) {
        const window = yield* owner(event);
        const returnUrl = yield* Effect.try({
          try: () => new URL(authorizationUrl).searchParams.get("redirect_uri"),
          catch: failure,
        });
        const entry = returnUrl ? listeners.get(returnUrl) : undefined;
        if (!entry || entry.ownerId !== window.webContents.id)
          return yield* Effect.fail(
            new PhoenixCloudCallbackError({
              detail: "Prepare Phoenix Cloud sign-in again in this window.",
            }),
          );
        const callback = yield* Effect.tryPromise({
          try: () =>
            entry.listener.receive(authorizationUrl, (url) => runPromise(shell.openExternal(url))),
          catch: failure,
        }).pipe(Effect.ensuring(Effect.sync(entry.dispose)));
        if (!window.isDestroyed()) yield* windows.reveal(window);
        return callback;
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.CANCEL_PHOENIX_CLOUD_CALLBACK_CHANNEL,
      payload: Request,
      result: Schema.Void,
      handler: Effect.fn("desktop.ipc.phoenixCloud.cancel")(function* (returnUrl, event) {
        const window = yield* owner(event);
        const entry = listeners.get(returnUrl);
        if (entry?.ownerId === window.webContents.id) entry.dispose();
      }),
    }),
  );
});
