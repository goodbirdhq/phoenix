import {
  ConnectionTransientError,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("retires managed credentials without removing saved connection metadata", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("legacy-managed-environment");
      const raw = encodeUnknownJson({
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
      const writes: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed(raw),
        write: (value) => Effect.sync(() => writes.push(value)),
      });

      const loaded = yield* store.read;
      expect(loaded.targets).toHaveLength(2);
      expect(loaded.targets[1]).toEqual(
        new RelayConnectionTarget({ environmentId, label: "Legacy managed environment" }),
      );
      expect(loaded.profiles).toHaveLength(1);
      expect(loaded.credentials).toHaveLength(1);
      expect(loaded.remoteDpopTokens).toEqual([]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(loaded);
    }),
  );

  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
