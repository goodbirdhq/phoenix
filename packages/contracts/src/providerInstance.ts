/**
 * Provider-instance contracts.
 *
 * Splits the historical "provider kind" concept into two:
 *
 *   - `ProviderDriverKind` is the implementation kind selector (e.g. codex,
 *     claudeAgent, a fork's `ollama`, …). It picks which driver package
 *     handles the protocol, the probe, the adapter, and text generation.
 *
 *   - `ProviderInstanceId` is the routing key (a user-defined slug).
 *     Threads, sessions, runtime events, and persisted bindings reference
 *     instance ids — never driver kinds — so a user can configure multiple
 *     instances of the same driver (e.g. `codex_personal` + `codex_work`),
 *     each with independent driver-specific configuration.
 *
 * Forward/backward compatibility invariant
 * ----------------------------------------
 * `ProviderDriverKind` is intentionally an **open** branded slug, not a closed
 * literal union. The server hosts forks, ships in PRs that add drivers, and
 * users frequently roll between branches and forks. Any of those paths can
 * leave `ServerSettings`, persisted thread state, or session bindings
 * referencing a driver that the currently-running build does not know about.
 *
 * The rule: parsing any of those payloads must always succeed, and the
 * runtime is responsible for marking the unknown driver/instance as
 * "unavailable" rather than crashing. Built-in drivers shipped by the core
 * product happens to register in a given build is not part of the contract
 * layer. Driver availability is discovered through the runtime registry.
 *
 * Driver-specific configuration is similarly opaque at the contracts layer:
 * drivers live in (or will be extracted to) their own packages and own their
 * config schemas. The contracts package only knows the envelope.
 *
 * @module providerInstance
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
/**
 * Slug pattern shared by driver kinds and instance ids — letters, digits,
 * dashes, underscores. The first character must be a letter so slugs remain
 * JS-identifier friendly when used as object keys, log fields, or telemetry
 * attributes. Mixed case is permitted so historical driver kinds (e.g.
 * `claudeAgent`) can be used verbatim during the migration and so external
 * fork authors retain reasonable freedom.
 */
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

/**
 * `ProviderDriverKind` — open branded slug naming a driver implementation.
 *
 * Constraints (validated at the schema layer):
 *   - starts with a letter
 *   - only letters, digits, `-`, `_` after the first char
 *   - 1..64 characters
 *
 * Notably **not** validated: that the driver is one we know how to load.
 * That check belongs to the runtime registry, which downgrades unknown
 * drivers gracefully (see module docs).
 */
export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

/**
 * `ProviderInstanceId` — user-defined routing key for a configured provider
 * instance. Same slug rules as `ProviderDriverKind`; branded separately so the
 * type system cannot confuse the two.
 */
export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

/**
 * Lightweight reference identifying which driver implements an instance.
 * Carried alongside `ProviderInstanceId` on wire shapes so consumers can
 * branch on driver behavior (icons, capabilities, presentation) without
 * having to look up the instance in the registry.
 */
export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/**
 * `ProviderFailoverGroup` — free-form tag naming an auto-failover set.
 *
 * A failover group is an auto-failover set and nothing else: instances
 * carrying the same tag are interchangeable accounts a rate-limited thread
 * may move between without asking. There is no group entity, no priority
 * ordering, and no membership list to keep in sync — a group exists exactly
 * as long as some instance is tagged with it. Untagged instances never
 * migrate automatically, which is what keeps a work thread off a personal
 * subscription.
 *
 * Members must share one driver (see `failoverGroupDriverConflicts`); the
 * target within a group is chosen at failover time from remaining quota.
 */
export const ProviderFailoverGroup = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
).pipe(Schema.brand("ProviderFailoverGroup"));
export type ProviderFailoverGroup = typeof ProviderFailoverGroup.Type;

/**
 * Envelope shape for a provider instance configuration in `ServerSettings`.
 *
 * `driver` is intentionally accepted as any well-formed slug (see module
 * docs). The driver-specific config payload is left as `Schema.Unknown`;
 * each driver registers its own decoder with the runtime registry, and
 * envelopes for unknown drivers are preserved verbatim so they round-trip
 * across version changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
  // Absent means "never fail over to or from this instance automatically".
  failoverGroup: Schema.optional(ProviderFailoverGroup),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

/**
 * Map shape for `ServerSettings.providerInstances`. Keyed by
 * `ProviderInstanceId`, values are envelopes the registry feeds to drivers.
 */
export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * Instances grouped by their failover tag, in map iteration order.
 * Untagged instances are absent. Exposed so the runtime can resolve a
 * group's members without re-deriving the (trivial) grouping rule, and so
 * the same rule backs both validation and target selection.
 */
export const groupProviderInstancesByFailoverGroup = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyMap<
  ProviderFailoverGroup,
  ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind }>
> => {
  const groups = new Map<
    ProviderFailoverGroup,
    Array<{ instanceId: ProviderInstanceId; driver: ProviderDriverKind }>
  >();
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.failoverGroup === undefined) continue;
    const members = groups.get(instance.failoverGroup);
    const member = {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: instance.driver,
    };
    if (members) members.push(member);
    else groups.set(instance.failoverGroup, [member]);
  }
  return groups;
};

/**
 * Groups whose members do not all share one driver. Cross-driver failover
 * is out of scope: a group promises interchangeable accounts, and two
 * drivers are not interchangeable (different models, credentials, and
 * capabilities).
 *
 * Reported rather than thrown at the read boundary — settings written by a
 * newer build, a fork, or a hand edit must still decode (see the module
 * docs). The write path rejects them; the runtime skips them.
 */
export const failoverGroupDriverConflicts = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyArray<{
  readonly group: ProviderFailoverGroup;
  readonly drivers: ReadonlyArray<ProviderDriverKind>;
}> => {
  const conflicts: Array<{
    group: ProviderFailoverGroup;
    drivers: ReadonlyArray<ProviderDriverKind>;
  }> = [];
  for (const [group, members] of groupProviderInstancesByFailoverGroup(instances)) {
    const drivers = [...new Set(members.map((member) => member.driver))];
    if (drivers.length > 1) conflicts.push({ group, drivers });
  }
  return conflicts;
};

export const failoverGroupsShareOneDriver = Schema.makeFilter(
  (instances: Readonly<Record<string, ProviderInstanceConfig>>) => {
    const conflicts = failoverGroupDriverConflicts(instances);
    if (conflicts.length === 0) return true;
    return conflicts
      .map(
        (conflict) =>
          `failover group '${conflict.group}' mixes drivers ${conflict.drivers.join(", ")}`,
      )
      .join("; ");
  },
  { identifier: "ProviderFailoverGroupsShareOneDriver" },
);

/**
 * Write-path instance map. Same shape as `ProviderInstanceConfigMap` plus
 * the same-driver group check, so a client cannot save a group that would
 * fail over across drivers. The read path stays permissive on purpose.
 */
export const WritableProviderInstanceConfigMap = ProviderInstanceConfigMap.check(
  failoverGroupsShareOneDriver,
);
export type WritableProviderInstanceConfigMap = typeof WritableProviderInstanceConfigMap.Type;

/**
 * Construct the canonical `ProviderInstanceId` used as a back-compat default
 * for a built-in driver. The legacy single-instance-per-driver world used
 * the driver kind itself as the instance id; preserving that mapping keeps
 * existing persisted threads, bindings, and cache files routable across the
 * migration without rewriting their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
