import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopSingleInstance from "./DesktopSingleInstance.ts";

describe("DesktopSingleInstance", () => {
  it.effect("registers the second-instance handler in the primary instance", () => {
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      requestSingleInstanceLock: Effect.succeed(true),
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance"]);
    }).pipe(
      Effect.provide(DesktopSingleInstance.layer),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      requestSingleInstanceLock: Effect.succeed(false),
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(DesktopSingleInstance.layer),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });
});
