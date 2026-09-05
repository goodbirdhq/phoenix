/**
 * Where each configured provider instance keeps its state on this machine.
 *
 * A feature that wants "the Claude home" almost never wants one directory: a
 * machine can have several signed-in accounts, each a `providerInstances`
 * entry with its own `homePath`. Reading `settings.providers.claudeAgent`
 * alone silently sees the default instance and nothing else, which reads as
 * missing usage, or as a workflow script that does not exist.
 *
 * These helpers are the one answer to that question, so a feature cannot go
 * back to seeing a single home by accident. They resolve paths only: whether a
 * directory exists, and what to do when it does not, belongs to the caller.
 *
 * @module provider/providerHomes
 */
import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

/**
 * The legacy single-instance-per-driver blob a driver's default instance falls
 * back to. `ProviderInstanceRegistryHydration` mirrors these into synthesized
 * instances; anything that reads settings directly has to apply the same rule
 * or it will disagree with the registry about what is configured.
 */
export const legacyProviderConfigFor = (
  settings: ServerSettings,
  driver: ProviderDriverKind,
): unknown => settings.providers[driver as keyof ServerSettings["providers"]];

export interface ProviderInstanceConfigEntry {
  readonly instanceId: string;
  readonly config: unknown;
  readonly environment: ProviderInstanceEnvironment | undefined;
}

/**
 * Every configured instance of one driver, legacy mirror included, ordered by
 * instance id so a scan reports its sources in the same order on every read.
 *
 * Disabled instances are included: their on-disk state is still theirs, and a
 * feature that reads history (usage, above all) must not rewrite the past when
 * an account is switched off.
 */
export const providerInstanceConfigsForDriver = (
  settings: ServerSettings,
  driver: ProviderDriverKind,
): ReadonlyArray<ProviderInstanceConfigEntry> => {
  const entries: ProviderInstanceConfigEntry[] = [];
  for (const [instanceId, instance] of Object.entries(
    settings.providerInstances as Record<string, ProviderInstanceConfig>,
  )) {
    if (instance.driver === driver) {
      entries.push({ instanceId, config: instance.config, environment: instance.environment });
    }
  }

  const defaultInstanceId = defaultInstanceIdForDriver(driver);
  if (!(defaultInstanceId in settings.providerInstances)) {
    const legacy = legacyProviderConfigFor(settings, driver);
    if (legacy !== undefined) {
      entries.push({ instanceId: defaultInstanceId, config: legacy, environment: undefined });
    }
  }

  return entries.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
};

const decodeClaudeSettings = Schema.decodeUnknownExit(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownExit(CodexSettings);

export interface ProviderInstanceHome {
  readonly instanceIds: readonly string[];
  /** Resolved and absolute; `~` expanded against this server's home. */
  readonly homePath: string;
  /**
   * Whether the instance names its own home rather than inheriting the OS one.
   * An overridden home *is* the provider's config dir, so its layout differs —
   * see {@link claudeProjectsDirCandidates}.
   */
  readonly overridden: boolean;
}

/**
 * Resolved `CLAUDE_CONFIG_DIR` of every configured Claude instance, without
 * duplicates — two instances may legitimately share one home, and a caller
 * that scans it twice would double count.
 *
 * An instance whose stored config cannot be decoded is skipped rather than
 * failing the read: the registry already surfaces that instance as
 * unavailable, and one broken entry must not blank out every other account.
 */
export const claudeInstanceHomes = Effect.fn("providerHomes.claudeInstanceHomes")(function* (
  settings: ServerSettings,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const homes: (Omit<ProviderInstanceHome, "instanceIds"> & { instanceIds: string[] })[] = [];
  for (const entry of providerInstanceConfigsForDriver(settings, CLAUDE_DRIVER)) {
    const decoded = decodeClaudeSettings(entry.config ?? {});
    if (!Exit.isSuccess(decoded)) {
      yield* Effect.logDebug("Skipping Claude instance with undecodable config.", {
        instanceId: entry.instanceId,
      });
      continue;
    }
    const homePath = yield* resolveClaudeHomePath(decoded.value);
    const existing = homes.find((home) => home.homePath === homePath);
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    homes.push({
      instanceIds: [entry.instanceId],
      homePath,
      overridden: decoded.value.homePath.trim().length > 0,
    });
  }
  return homes;
});

/**
 * Resolved shared `CODEX_HOME` of every configured Codex instance, without
 * duplicates. The shared home is the one that holds `sessions/`: an auth
 * overlay gives an instance its own credentials, not its own transcripts.
 */
export const codexInstanceHomes = Effect.fn("providerHomes.codexInstanceHomes")(function* (
  settings: ServerSettings,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const homes: (Omit<ProviderInstanceHome, "instanceIds"> & { instanceIds: string[] })[] = [];
  for (const entry of providerInstanceConfigsForDriver(settings, CODEX_DRIVER)) {
    const decoded = decodeCodexSettings(entry.config ?? {});
    if (!Exit.isSuccess(decoded)) {
      yield* Effect.logDebug("Skipping Codex instance with undecodable config.", {
        instanceId: entry.instanceId,
      });
      continue;
    }
    const layout = yield* resolveCodexHomeLayout(decoded.value);
    const existing = homes.find((home) => home.homePath === layout.sharedHomePath);
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    homes.push({
      instanceIds: [entry.instanceId],
      homePath: layout.sharedHomePath,
      overridden: decoded.value.homePath.trim().length > 0,
    });
  }
  return homes;
});

export interface OpenCodeInstanceDatabase {
  readonly instanceIds: readonly string[];
  readonly databasePath: string;
}

/**
 * Resolves the SQLite store used by every configured OpenCode instance.
 *
 * OpenCode follows XDG for its data directory and lets `OPENCODE_DB` select a
 * different file. A relative override is resolved below the OpenCode data
 * directory, matching OpenCode itself. In-memory stores have no history a
 * separate Phoenix process can read, so they are omitted.
 */
export const opencodeInstanceDatabases = Effect.fn("providerHomes.opencodeInstanceDatabases")(
  function* (
    settings: ServerSettings,
    baseEnvironment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ReadonlyArray<OpenCodeInstanceDatabase>, never, Path.Path> {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const databases: { instanceIds: string[]; databasePath: string }[] = [];

    for (const entry of providerInstanceConfigsForDriver(settings, OPENCODE_DRIVER)) {
      const environment = mergeProviderInstanceEnvironment(entry.environment, baseEnvironment);

      const configuredDataHome = environment.XDG_DATA_HOME?.trim();
      const effectiveHome =
        (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ||
        NodeOS.homedir();
      const dataHome = configuredDataHome || path.join(effectiveHome, ".local", "share");
      const openCodeDataDir = path.join(dataHome, "opencode");
      const configuredDatabase = environment.OPENCODE_DB?.trim();
      if (configuredDatabase === ":memory:") continue;
      const databasePath =
        configuredDatabase && path.isAbsolute(configuredDatabase)
          ? configuredDatabase
          : path.join(openCodeDataDir, configuredDatabase || "opencode.db");

      const existing = databases.find((database) => database.databasePath === databasePath);
      if (existing) {
        existing.instanceIds.push(entry.instanceId);
        continue;
      }
      databases.push({ instanceIds: [entry.instanceId], databasePath });
    }

    return databases;
  },
);

/** Grok history roots follow each configured instance's process environment. */
export const grokInstanceHomes = Effect.fn("providerHomes.grokInstanceHomes")(function* (
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const homes: (Omit<ProviderInstanceHome, "instanceIds"> & { instanceIds: string[] })[] = [];
  for (const entry of providerInstanceConfigsForDriver(settings, ProviderDriverKind.make("grok"))) {
    const environment = mergeProviderInstanceEnvironment(entry.environment, baseEnvironment);
    const configuredHome = environment.GROK_HOME?.trim();
    const userHome =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ||
      NodeOS.homedir();
    const homePath = path.resolve(
      configuredHome ? expandHomePath(configuredHome) : path.join(userHome, ".grok"),
    );
    const existing = homes.find((home) => home.homePath === homePath);
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    homes.push({ instanceIds: [entry.instanceId], homePath, overridden: Boolean(configuredHome) });
  }
  return homes;
});

/**
 * The directories a Claude home may keep session transcripts and workflow
 * scripts under, in probe order.
 *
 * An overridden `CLAUDE_CONFIG_DIR` *is* the config dir, so transcripts sit
 * directly beneath it; a default install nests them under `~/.claude`. The
 * bare `<home>/projects` layout is offered only for an overridden home: on a
 * default one that path is just a directory in the user's home, and treating
 * it as provider state would have Phoenix reading files that are none of its
 * business.
 */
export const claudeProjectsDirCandidates = Effect.fn("providerHomes.claudeProjectsDirCandidates")(
  function* (home: ProviderInstanceHome): Effect.fn.Return<readonly string[], never, Path.Path> {
    const path = yield* Path.Path;
    const nested = path.join(home.homePath, ".claude", "projects");
    return home.overridden ? [nested, path.join(home.homePath, "projects")] : [nested];
  },
);
