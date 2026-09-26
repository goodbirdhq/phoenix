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
}

/**
 * Resolved `CLAUDE_CONFIG_DIR` of every configured Claude instance, without
 * duplicates — two instances may legitimately share one home, and a caller
 * that scans it twice would double count.
 *
 * The instance's `homePath` wins, then the `CLAUDE_CONFIG_DIR` its process
 * would inherit (its own environment over the server's), then `~/.claude` —
 * the same order the driver launches Claude with.
 *
 * An instance whose stored config cannot be decoded is skipped rather than
 * failing the read: the registry already surfaces that instance as
 * unavailable, and one broken entry must not blank out every other account.
 */
export const claudeInstanceHomes = Effect.fn("providerHomes.claudeInstanceHomes")(function* (
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const homes: { instanceIds: string[]; homePath: string }[] = [];
  for (const entry of providerInstanceConfigsForDriver(settings, CLAUDE_DRIVER)) {
    const decoded = decodeClaudeSettings(entry.config ?? {});
    if (!Exit.isSuccess(decoded)) {
      yield* Effect.logDebug("Skipping Claude instance with undecodable config.", {
        instanceId: entry.instanceId,
      });
      continue;
    }
    const homePath = yield* resolveClaudeHomePath(
      decoded.value,
      mergeProviderInstanceEnvironment(entry.environment, baseEnvironment),
    );
    const existing = homes.find((home) => home.homePath === homePath);
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    homes.push({ instanceIds: [entry.instanceId], homePath });
  }
  return homes;
});

/**
 * Resolved shared `CODEX_HOME` of every configured Codex instance, without
 * duplicates. The shared home is the one that holds `sessions/`: an auth
 * overlay gives an instance its own credentials, not its own transcripts.
 *
 * An instance with neither a home nor an overlay runs Codex under the
 * `CODEX_HOME` it inherits; an overlay exports its own, so an inherited one
 * never applies there.
 */
export const codexInstanceHomes = Effect.fn("providerHomes.codexInstanceHomes")(function* (
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const homes: { instanceIds: string[]; homePath: string }[] = [];
  for (const entry of providerInstanceConfigsForDriver(settings, CODEX_DRIVER)) {
    const decoded = decodeCodexSettings(entry.config ?? {});
    if (!Exit.isSuccess(decoded)) {
      yield* Effect.logDebug("Skipping Codex instance with undecodable config.", {
        instanceId: entry.instanceId,
      });
      continue;
    }
    const config = decoded.value;
    const inheritedHome = mergeProviderInstanceEnvironment(
      entry.environment,
      baseEnvironment,
    ).CODEX_HOME?.trim();
    const layout = yield* resolveCodexHomeLayout(
      !config.homePath.trim() && !config.shadowHomePath.trim() && inheritedHome
        ? { ...config, homePath: inheritedHome }
        : config,
    );
    const existing = homes.find((home) => home.homePath === layout.sharedHomePath);
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    homes.push({ instanceIds: [entry.instanceId], homePath: layout.sharedHomePath });
  }
  return homes;
});

export interface OpenCodeInstanceStore {
  readonly instanceIds: readonly string[];
  /** OpenCode's data directory, which holds its databases and older JSON history. */
  readonly dataDir: string;
  /** The one database an `OPENCODE_DB` override selects; otherwise every channel database. */
  readonly databasePath: string | undefined;
}

/**
 * Resolves the history store used by every configured OpenCode instance.
 *
 * OpenCode follows XDG for its data directory and lets `OPENCODE_DB` select a
 * different file. A relative override is resolved below the OpenCode data
 * directory, matching OpenCode itself. In-memory stores have no history a
 * separate Phoenix process can read, so they are omitted.
 */
export const opencodeInstanceStores = Effect.fn("providerHomes.opencodeInstanceStores")(function* (
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<OpenCodeInstanceStore>, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const stores: { instanceIds: string[]; dataDir: string; databasePath: string | undefined }[] = [];

  for (const entry of providerInstanceConfigsForDriver(settings, OPENCODE_DRIVER)) {
    const environment = mergeProviderInstanceEnvironment(entry.environment, baseEnvironment);

    const configuredDataHome = environment.XDG_DATA_HOME?.trim();
    const effectiveHome =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ||
      NodeOS.homedir();
    // The XDG spec says a relative data home is invalid and must be ignored.
    const dataHome =
      configuredDataHome && path.isAbsolute(configuredDataHome)
        ? configuredDataHome
        : path.join(effectiveHome, ".local", "share");
    const dataDir = path.join(dataHome, "opencode");
    const configuredDatabase = environment.OPENCODE_DB?.trim();
    if (configuredDatabase === ":memory:") continue;
    const databasePath = configuredDatabase ? path.resolve(dataDir, configuredDatabase) : undefined;

    const existing = stores.find(
      (store) => store.dataDir === dataDir && store.databasePath === databasePath,
    );
    if (existing) {
      existing.instanceIds.push(entry.instanceId);
      continue;
    }
    stores.push({ instanceIds: [entry.instanceId], dataDir, databasePath });
  }

  return stores;
});

/** Grok history roots follow each configured instance's process environment. */
export const grokInstanceHomes = Effect.fn("providerHomes.grokInstanceHomes")(function* (
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ProviderInstanceHome>, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const homes: { instanceIds: string[]; homePath: string }[] = [];
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
    homes.push({ instanceIds: [entry.instanceId], homePath });
  }
  return homes;
});

/**
 * The directories a Claude home keeps session transcripts and workflow
 * scripts under.
 *
 * A resolved Claude home is always the config dir itself (`~/.claude` by
 * default), so transcripts sit directly beneath it. A `.claude/projects`
 * nested inside a configured home is not where Claude writes, and reading it
 * would count files that are none of this account's business.
 */
export const claudeProjectsDirCandidates = Effect.fn("providerHomes.claudeProjectsDirCandidates")(
  function* (
    home: Pick<ProviderInstanceHome, "homePath">,
  ): Effect.fn.Return<readonly string[], never, Path.Path> {
    const path = yield* Path.Path;
    return [path.join(home.homePath, "projects")];
  },
);
