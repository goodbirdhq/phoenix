import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import { Command } from "effect/unstable/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  formatServiceStatus,
  offerServiceDuringOnboarding,
  reconcileService,
  recoverServiceOnboardingOffer,
  serviceCommand,
} from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/phoenix.service",
  logPath: "/home/me/.phoenix/userdata/logs/boot-service.log",
  runtimeVersion: "phoenix v0.0.29 (b421b138)",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29", "0.0.29 (b421b138)"),
    [
      "Phoenix service",
      "  Status: installed · phoenix@0.0.29",
      "  Service build: phoenix v0.0.29 (b421b138)",
      "  CLI build: 0.0.29 (b421b138)",
      "  Unit: /home/me/.config/systemd/user/phoenix.service",
      "  Logs: /home/me/.phoenix/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("shows the drift when the CLI has moved ahead of the running service", () => {
  const output = formatServiceStatus(status, "0.0.29", "0.0.30 (ff00ff00)");

  assert.include(output, "  Service build: phoenix v0.0.29 (b421b138)");
  assert.include(output, "  CLI build: 0.0.30 (ff00ff00)");
});

it("says the service build is unavailable rather than borrowing the CLI's", () => {
  assert.include(
    formatServiceStatus({ ...status, runtimeVersion: null }, "0.0.29", "0.0.29 (b421b138)"),
    "  Service build: unavailable",
  );
});

it("points a stale service at the published update command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx @goodbirdhq/phoenix@latest service update`.",
  );
});

it("advertises installation for a missing service", () => {
  const output = formatServiceStatus({ ...status, installed: false }, "0.0.29");
  assert.include(output, "Next: Run `phoenix service install`.");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it("reports a newer installed service and gives an exact-version repair command", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );

  assert.include(output, "phoenix@0.0.32-nightly.1 (newer than this phoenix@0.0.31 CLI)");
  assert.include(output, "rebuild Phoenix from source at 0.0.32-nightly.1");
  assert.notInclude(output, "npx t3@latest service update");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(serviceStatus: BootService.BootServiceStatus) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          nodePath: "/test/node",
          launcherPath: "/test/service-launcher.mjs",
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect.each(["install", "update"] as const)(
    "%s is not exposed by this source distribution",
    (command) =>
      Effect.gen(function* () {
        const { service, installOptions } = makeTestService(newerServiceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error._tag).toBe("ShowHelp");
        expect(installOptions).toEqual([]);
      }),
  );
});

it.effect.each([
  { name: "a new service", state: { ...status, installed: false, current: false } },
  { name: "an older service", state: { ...status, current: false, installedVersion: "0.0.0" } },
  {
    name: "the same version",
    state: { ...status, current: false, installedVersion: packageJson.version },
  },
  { name: "an unknown version", state: { ...status, current: false } },
])("installs or repairs $name without an override", ({ state }) =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(state);

    const result = yield* reconcileService().pipe(
      Effect.provideService(BootService.BootService, service),
    );

    expect(result.changed).toBe(true);
    expect(installOptions).toEqual([undefined]);
  }),
);

it.effect("leaves a newer service unchanged during onboarding without prompting", () =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(newerServiceStatus);
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("Onboarding must not prompt to replace a newer service."),
      readLine: Effect.die("Onboarding must not prompt to replace a newer service."),
      display: () => Effect.die("Onboarding must not prompt to replace a newer service."),
    });

    const ready = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(NodeServices.layer),
    );

    expect(ready).toBe(false);
    expect(installOptions).toEqual([]);
  }),
);

it.effect("keeps onboarding successful when a newer version appears before install", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(
        new BootService.BootServiceDowngradeRefusedError({
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        }),
      ),
    );

    expect(ready).toBe(false);
  }),
);
