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
  grokInstanceHomes,
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
      assert.deepEqual(homes[0]?.instanceIds, ["claudeAgent", "claudeAgent_dup"]);
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

describe("shared history membership", () => {
  effectIt.effect("retains every Codex auth overlay sharing a transcript home", () =>
    Effect.gen(function* () {
      const homes = yield* codexInstanceHomes(
        decodeSettings({
          providerInstances: {
            codex: { driver: "codex", config: { homePath: "/shared", shadowHomePath: "/auth/a" } },
            codex_b: {
              driver: "codex",
              config: { homePath: "/shared", shadowHomePath: "/auth/b" },
            },
            codex_c: { driver: "codex", config: { homePath: "/separate" } },
          },
        }),
      );
      assert.deepEqual(
        homes.map(({ homePath, instanceIds }) => ({ homePath, instanceIds })),
        [
          { homePath: "/shared", instanceIds: ["codex", "codex_b"] },
          { homePath: "/separate", instanceIds: ["codex_c"] },
        ],
      );
    }).pipe(Effect.provide(Path.layer)),
  );
  effectIt.effect("retains both OpenCode instances without scanning their database twice", () =>
    Effect.gen(function* () {
      const databases = yield* opencodeInstanceDatabases(
        decodeSettings({
          providerInstances: {
            opencode: { driver: "opencode" },
            opencode_b: { driver: "opencode" },
          },
        }),
        { XDG_DATA_HOME: "/data" },
      );
      assert.deepEqual(databases, [
        { databasePath: "/data/opencode/opencode.db", instanceIds: ["opencode", "opencode_b"] },
      ]);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(HostProcessPlatform, "linux")),
  );
  effectIt.effect("resolves Grok instances using their own environment overrides", () =>
    Effect.gen(function* () {
      const homes = yield* grokInstanceHomes(
        decodeSettings({
          providerInstances: {
            grok: { driver: "grok" },
            grok_b: { driver: "grok", environment: [{ name: "GROK_HOME", value: "/grok-b" }] },
            grok_c: {
              driver: "grok",
              environment: [
                { name: "GROK_HOME", value: "  " },
                { name: "HOME", value: "/user-c" },
              ],
            },
          },
        }),
        { GROK_HOME: "/grok-a" },
      );
      assert.deepEqual(
        homes.map(({ homePath, instanceIds }) => ({ homePath, instanceIds })),
        [
          { homePath: "/grok-a", instanceIds: ["grok"] },
          { homePath: "/grok-b", instanceIds: ["grok_b"] },
          { homePath: "/user-c/.grok", instanceIds: ["grok_c"] },
        ],
      );
    }).pipe(Effect.provide(Path.layer), Effect.provideService(HostProcessPlatform, "linux")),
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
          instanceIds: ["opencode"],
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
        instanceIds: ["claudeAgent"],
        homePath: "/homes/a",
        overridden: true,
      });
      assert.deepEqual(overridden, ["/homes/a/.claude/projects", "/homes/a/projects"]);

      // A default install's home is the user's own; only the nested layout
      // there belongs to Claude.
      const inherited = yield* claudeProjectsDirCandidates({
        instanceIds: ["claudeAgent"],
        homePath: "/homes/a",
        overridden: false,
      });
      assert.deepEqual(inherited, ["/homes/a/.claude/projects"]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
