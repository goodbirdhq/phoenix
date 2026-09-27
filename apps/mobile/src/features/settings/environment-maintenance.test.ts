import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-personal",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T00:00:00.000Z",
  models: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    canUpdate: true,
    updateCommand: null,
    checkedAt: null,
    message: null,
  },
});

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it("requires remote desktop update support for desktop hosts", () => {
    expect(supportsEnvironmentUpdate({})).toBe(false);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "respawn" })).toBe(true);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed" })).toBe(false);
    expect(
      supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed", desktopAppUpdate: true }),
    ).toBe(true);
  });

  it("excludes unavailable, manual, busy, and incompatible provider updates", () => {
    expect(canUpdateEnvironmentProvider(provider)).toBe(true);
    expect(canUpdateEnvironmentProvider({ ...provider, installed: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, availability: "unavailable" })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, versionAdvisory: undefined })).toBe(false);
    for (const latestVersionStatus of ["broken", "unsupported"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }),
      ).toBe(false);
    }
    for (const status of ["queued", "running"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          updateState: {
            status,
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ).toBe(false);
    }
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: {
          ...provider.versionAdvisory!,
          canUpdate: false,
        },
      }),
    ).toBe(false);
  });
});
