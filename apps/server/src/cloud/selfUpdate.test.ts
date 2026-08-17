import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

const makeForMode = (mode: "web" | "desktop") =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
    );
    return yield* ServerSelfUpdate.make().pipe(
      Effect.provide(ServerConfig.layer({ ...config, mode })),
    );
  });

it("only advertises desktop-managed updates", () => {
  expect(ServerSelfUpdate.resolveServerSelfUpdateCapability({ desktopManaged: true })).toBe(
    "desktop-managed",
  );
  expect(ServerSelfUpdate.resolveServerSelfUpdateCapability({ desktopManaged: false })).toBeNull();
});

it.effect("rejects npm-based server updates before reporting progress", () =>
  Effect.gen(function* () {
    const service = yield* makeForMode("web");
    const reportProgress = vi.fn(() => Effect.void);
    const error = yield* service
      .update({ targetVersion: "1.1.0" }, reportProgress)
      .pipe(Effect.flip);

    expect(error.reason).toContain("owned package distribution");
    expect(reportProgress).not.toHaveBeenCalled();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("directs desktop-managed servers to the desktop app", () =>
  Effect.gen(function* () {
    const service = yield* makeForMode("desktop");
    const error = yield* service.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);

    expect(error.reason).toContain("desktop app");
  }).pipe(Effect.provide(NodeServices.layer)),
);
