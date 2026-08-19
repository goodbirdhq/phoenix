import {
  ProviderFailoverGroup,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ProviderFailoverInstance {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}

export interface ProviderFailoverGroupOption {
  readonly name: ProviderFailoverGroup;
  readonly memberLabels: ReadonlyArray<string>;
}

const isProviderFailoverGroup = Schema.is(ProviderFailoverGroup);

function providerInstanceLabel(row: ProviderFailoverInstance): string {
  return row.instance.displayName?.trim() || String(row.instanceId);
}

export function deriveProviderFailoverGroupOptions(
  rows: ReadonlyArray<ProviderFailoverInstance>,
  driver: ProviderDriverKind,
): ReadonlyArray<ProviderFailoverGroupOption> {
  const membersByGroup = new Map<ProviderFailoverGroup, string[]>();

  for (const row of rows) {
    const group = row.instance.failoverGroup;
    if (row.instance.driver !== driver || group === undefined) continue;
    const members = membersByGroup.get(group) ?? [];
    members.push(providerInstanceLabel(row));
    membersByGroup.set(group, members);
  }

  return [...membersByGroup].map(([name, memberLabels]) => ({ name, memberLabels }));
}

export function validateProviderFailoverGroupName(
  rawName: string,
  rows: ReadonlyArray<ProviderFailoverInstance>,
  driver: ProviderDriverKind,
): string | null {
  const name = rawName.trim();
  if (name.length === 0) {
    return "Enter a group name.";
  }
  if (!isProviderFailoverGroup(name)) {
    return "Use a group name with 64 characters or fewer.";
  }
  if (rows.some((row) => row.instance.failoverGroup === name && row.instance.driver !== driver)) {
    return `“${name}” is already used by another provider. Failover groups can only contain accounts from one provider.`;
  }
  return null;
}

export function providerInstanceWithFailoverGroup(
  instance: ProviderInstanceConfig,
  rawName: string | null,
): ProviderInstanceConfig {
  const { failoverGroup: _omit, ...rest } = instance;
  const name = rawName?.trim();
  return name
    ? {
        ...rest,
        failoverGroup: ProviderFailoverGroup.make(name),
      }
    : rest;
}
