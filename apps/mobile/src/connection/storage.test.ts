import { describe, expect, it } from "@effect/vitest";
import { RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const writes: Array<{ readonly key: string; readonly value: string }> = [];
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        writes.push({ key, value });
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values, writes };
}

describe("mobile connection catalog storage", () => {
  it.effect("retires managed credentials without removing saved connection metadata", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("legacy-managed-environment");
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            _tag: "BearerConnectionTarget",
            environmentId: "direct-environment",
            label: "Direct environment",
            connectionId: "bearer:direct-environment",
          },
          {
            _tag: "RelayConnectionTarget",
            environmentId,
            label: "Legacy managed environment",
          },
        ],
        profiles: [
          {
            _tag: "BearerConnectionProfile",
            environmentId: "direct-environment",
            label: "Direct environment",
            connectionId: "bearer:direct-environment",
            httpBaseUrl: "https://direct.example.test",
            wsBaseUrl: "wss://direct.example.test",
          },
        ],
        credentials: [
          {
            connectionId: "bearer:direct-environment",
            credential: { _tag: "BearerConnectionCredential", token: "direct-token" },
          },
        ],
        remoteDpopTokens: [
          {
            environmentId,
            label: "Legacy managed environment",
            endpoint: {
              httpBaseUrl: "https://relay.example.test",
              wsBaseUrl: "wss://relay.example.test",
              providerKind: "cloudflare_tunnel",
            },
            accessToken: "retired-token",
            expiresAtEpochMs: 1,
            dpopThumbprint: "legacy-thumbprint",
          },
        ],
      });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: raw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const loaded = yield* catalog.read;
      expect(loaded.targets).toHaveLength(2);
      expect(loaded.targets[1]).toEqual(
        new RelayConnectionTarget({ environmentId, label: "Legacy managed environment" }),
      );
      expect(loaded.profiles).toHaveLength(1);
      expect(loaded.credentials).toHaveLength(1);
      expect(loaded.remoteDpopTokens).toEqual([]);
      expect(memory.writes).toHaveLength(1);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toBe(raw);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
