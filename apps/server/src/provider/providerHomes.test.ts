// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderDriverKind, ServerSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import {
  claudeInstanceHomes,
  claudeProjectsDirCandidates,
  codexInstanceHomes,
  opencodeInstanceDatabases,
  providerInstanceConfigsForDriver,
} from "./providerHomes.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const homePaths = (homes: ReadonlyArray<{ readonly homePath: string }>) =>
  homes.map((home) => home.homePath);

describe("claudeInstanceHomes", () => {
  effectIt.effect("reads the legacy per-driver config when no instance overrides it", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ providers: { claudeAgent: { homePath: "~/.claude-a" } } });
      const homes = yield* claudeInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), [NodePath.join(NodeOS.homedir(), ".claude-a")]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("reads every configured account, not just the default one", () =>
    Effect.gen(function* () {
      // The shape a second signed-in account actually persists as: a partial
      // config carrying nothing but its own home.
      const settings = decodeSettings({
        providers: { claudeAgent: { homePath: "/homes/a" } },
        providerInstances: {
          claudeAgent_claude_b: { driver: "claudeAgent", config: { homePath: "/homes/b" } },
        },
      });
      const homes = yield* claudeInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), ["/homes/a", "/homes/b"]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("includes a disabled account, whose past usage is still its own", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", enabled: false, config: { homePath: "/homes/a" } },
        },
      });
      const homes = yield* claudeInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), ["/homes/a"]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("resolves one home once, however many instances point at it", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { claudeAgent: { homePath: "/homes/a" } },
        providerInstances: {
          claudeAgent_dup: { driver: "claudeAgent", config: { homePath: "/homes/a/" } },
        },
      });
      const homes = yield* claudeInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), ["/homes/a"]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("skips an instance whose stored config cannot be decoded", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { claudeAgent: { homePath: "/homes/a" } },
        providerInstances: {
          claudeAgent_broken: { driver: "claudeAgent", config: { homePath: 42 } },
        },
      });
      const homes = yield* claudeInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), ["/homes/a"]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("defaults to this machine's home when nothing is configured", () =>
    Effect.gen(function* () {
      const homes = yield* claudeInstanceHomes(decodeSettings({}));
      assert.deepEqual(homePaths(homes), [NodeOS.homedir()]);
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe("providerInstanceConfigsForDriver", () => {
  it("does not mirror the legacy config once an explicit default instance exists", () => {
    const settings = decodeSettings({
      providers: { claudeAgent: { homePath: "/homes/legacy" } },
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", config: { homePath: "/homes/explicit" } },
      },
    });
    const entries = providerInstanceConfigsForDriver(settings, CLAUDE);
    assert.deepEqual(
      entries.map((entry) => (entry.config as { homePath?: string }).homePath),
      ["/homes/explicit"],
    );
  });
});

describe("codexInstanceHomes", () => {
  effectIt.effect("reads the shared home, which is where sessions live", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { codex: { homePath: "/homes/codex", shadowHomePath: "/homes/codex-shadow" } },
      });
      const homes = yield* codexInstanceHomes(settings);
      // The shadow home holds credentials, not transcripts.
      assert.deepEqual(homePaths(homes), ["/homes/codex"]);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("reads a second Codex account's home", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { codex: { homePath: "/homes/codex" } },
        providerInstances: {
          codex_work: { driver: "codex", config: { homePath: "/homes/codex-work" } },
        },
      });
      const homes = yield* codexInstanceHomes(settings);
      assert.deepEqual(homePaths(homes), ["/homes/codex", "/homes/codex-work"]);
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe("opencodeInstanceDatabases", () => {
  effectIt.effect("resolves the default database from each instance's XDG data home", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          opencode: {
            driver: "opencode",
            environment: [{ name: "XDG_DATA_HOME", value: "/data/open-code" }],
          },
        },
      });
      const databases = yield* opencodeInstanceDatabases(settings, {});
      assert.deepEqual(databases, [
        {
          instanceId: "opencode",
          databasePath: "/data/open-code/opencode/opencode.db",
        },
      ]);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(HostProcessPlatform, "linux")),
  );

  effectIt.effect("honors relative and absolute OPENCODE_DB overrides", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          opencode: {
            driver: "opencode",
            environment: [
              { name: "XDG_DATA_HOME", value: "/data/open-code" },
              { name: "OPENCODE_DB", value: "work.db" },
            ],
          },
          opencode_absolute: {
            driver: "opencode",
            environment: [{ name: "OPENCODE_DB", value: "/accounts/personal.db" }],
          },
        },
      });
      const databases = yield* opencodeInstanceDatabases(settings, {});
      assert.deepEqual(databases.map((database) => database.databasePath).toSorted(), [
        "/accounts/personal.db",
        "/data/open-code/opencode/work.db",
      ]);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(HostProcessPlatform, "linux")),
  );
});

describe("claudeProjectsDirCandidates", () => {
  effectIt.effect("probes the nested layout before the overridden one", () =>
    Effect.gen(function* () {
      const overridden = yield* claudeProjectsDirCandidates({
        instanceId: "claudeAgent",
        homePath: "/homes/a",
        overridden: true,
      });
      assert.deepEqual(overridden, ["/homes/a/.claude/projects", "/homes/a/projects"]);

      // A default install's home is the user's own; only the nested layout
      // there belongs to Claude.
      const inherited = yield* claudeProjectsDirCandidates({
        instanceId: "claudeAgent",
        homePath: "/homes/a",
        overridden: false,
      });
      assert.deepEqual(inherited, ["/homes/a/.claude/projects"]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
