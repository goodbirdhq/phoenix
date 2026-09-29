/**
 * Test helpers for constructing a `ProviderAdapterRegistryShape` mock from a
 * kind-keyed adapter map.
 *
 * @module provider/testUtils/providerAdapterRegistryMock
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";

export type KindAdapterMap = Partial<
  Record<ProviderDriverKind, ProviderAdapterShape<ProviderAdapterError>>
>;

/** Extra instance ids to serve, beyond each driver's default instance. */
export type InstanceAdapterMap = Readonly<
  Record<string, ProviderAdapterShape<ProviderAdapterError>>
>;

/**
 * Build a `ProviderAdapterRegistryShape` from a kind-keyed adapter map.
 * Every adapter present in the map is addressable through its default
 * provider instance id.
 *
 * `extraInstances` registers further instance ids against an adapter, which is
 * how a test gets two accounts on one driver. Their continuation keys differ by
 * instance id, so migrating between them is treated as crossing accounts —
 * the case a single default instance per driver cannot express.
 */
export const makeAdapterRegistryMock = (
  adapters: KindAdapterMap,
  extraInstances?: InstanceAdapterMap,
): ProviderAdapterRegistryShape => {
  const byInstanceId = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
  for (const [kind, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const driverKind = ProviderDriverKind.make(kind);
    byInstanceId.set(defaultInstanceIdForDriver(driverKind), adapter);
  }
  for (const [instanceId, adapter] of Object.entries(extraInstances ?? {})) {
    byInstanceId.set(instanceId as ProviderInstanceId, adapter);
  }

  const getByInstance: ProviderAdapterRegistryShape["getByInstance"] = (instanceId) => {
    const adapter = byInstanceId.get(instanceId);
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
  };

  return {
    getByInstance,
    getInstanceInfo: (instanceId) => {
      const adapter = byInstanceId.get(instanceId);
      if (!adapter) {
        return Effect.fail(
          new ProviderUnsupportedError({
            provider: ProviderDriverKind.make(instanceId),
          }),
        );
      }
      return Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(adapter.provider),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(adapter.provider),
          continuationKey: `${adapter.provider}:instance:${instanceId}`,
        },
      });
    },
    listInstances: () => Effect.succeed(Array.from(byInstanceId.keys())),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};
