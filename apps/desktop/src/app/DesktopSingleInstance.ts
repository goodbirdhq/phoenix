import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

export class DesktopSingleInstance extends Context.Service<
  DesktopSingleInstance,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopSingleInstance") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.sync(() =>
  DesktopSingleInstance.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // The single-instance lock is scoped to the userData directory, which
      // startup sets before this runs. A secondary instance quits here;
      // app.quit() is asynchronous, so stop bootstrap before whenReady fires.
      if (!(yield* electronApp.requestSingleInstanceLock)) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      yield* electronApp.on("second-instance", () => {
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.single_instance.configure")),
  }),
);

export const layer = Layer.effect(DesktopSingleInstance, make);
