import { useMemo } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind, ServerConfig } from "@t3tools/contracts";

/** Provider identity for the leading avatar and accessible account label. */
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
}

/**
 * Resolve the provider instance a thread runs on, scoped to the thread's own
 * environment: default instance ids are the driver slug, so the same id
 * names a different account on every server.
 */
export function resolveThreadProviderInstance(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  const providers = serverConfigs.get(thread.environmentId)?.providers ?? [];
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  return {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
  };
}

/**
 * Builds a resolver handing out reference-stable `ThreadRowProviderInstance`
 * objects. `resolveThreadProviderInstance` builds a fresh object per call,
 * which breaks the memoized row's props comparison on every parent render —
 * the result only depends on (environment, instance id), so one cache per
 * server-config generation keeps each row's `providerInstance` prop stable
 * until the instance behind the row actually changes.
 */
export function createThreadRowProviderInstanceResolver(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cacheKey = `${thread.environmentId}|${instanceId ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(serverConfigs, thread);
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

/** List-scoped wrapper: one cache per server-config generation. */
export function useThreadRowProviderInstanceResolver(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(() => createThreadRowProviderInstanceResolver(serverConfigs), [serverConfigs]);
}
