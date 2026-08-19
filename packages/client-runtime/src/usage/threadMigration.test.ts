import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAvailability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MIGRATION_BRIEF_LIMITED_REASON,
  MIGRATION_STREAMING_BLOCK_REASON,
  deriveMigrationModeAvailability,
  findFailedTurnUserMessage,
  rankMigrationTargets,
  resolveThreadBoundInstanceId,
  shouldShowUsageLimitMigrationPopup,
} from "./threadMigration.js";

const availability = (usedPercent: number): ProviderAvailability => ({
  status: usedPercent >= 100 ? "limited" : "available",
  source: "codex_app_server",
  observedAt: "2026-08-19T12:00:00.000Z",
  windows: [{ kind: "session", usedPercent }],
});

describe("thread migration derivations", () => {
  it("binds to the live session before the persisted picker selection", () => {
    expect(
      resolveThreadBoundInstanceId({
        sessionProviderInstanceId: ProviderInstanceId.make("session-account"),
        threadModelSelectionInstanceId: ProviderInstanceId.make("picker-account"),
      }),
    ).toBe("session-account");
    expect(
      resolveThreadBoundInstanceId({
        sessionProviderInstanceId: null,
        threadModelSelectionInstanceId: ProviderInstanceId.make("persisted-account"),
      }),
    ).toBe("persisted-account");
  });

  it("ranks ready same-driver targets by remaining quota before cross-driver targets", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const personal = ProviderInstanceId.make("personal");
    const spare = ProviderInstanceId.make("spare");
    const crossDriver = ProviderInstanceId.make("codex-work");
    const limited = ProviderInstanceId.make("limited");
    const availabilityByInstanceId = new Map([
      [personal, availability(82)],
      [spare, availability(31)],
      [crossDriver, availability(4)],
      [limited, availability(100)],
    ]);

    expect(
      rankMigrationTargets({
        originInstanceId: ProviderInstanceId.make("origin"),
        originDriverKind: claude,
        availabilityByInstanceId,
        candidates: [
          {
            instanceId: personal,
            driverKind: claude,
            displayName: "Personal",
            enabled: true,
            isAvailable: true,
            status: "ready",
          },
          {
            instanceId: spare,
            driverKind: claude,
            displayName: "Spare",
            enabled: true,
            isAvailable: true,
            status: "ready",
          },
          {
            instanceId: crossDriver,
            driverKind: codex,
            displayName: "Codex",
            enabled: true,
            isAvailable: true,
            status: "ready",
          },
          {
            instanceId: limited,
            driverKind: claude,
            displayName: "Limited",
            enabled: true,
            isAvailable: true,
            status: "ready",
          },
        ],
      }).map((target) => target.instanceId),
    ).toEqual([spare, personal, crossDriver]);
  });

  it("shows on native or typed usage-limit signals and gates handoff modes", () => {
    const instanceId = ProviderInstanceId.make("origin");
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(100),
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: null,
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(10),
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(10),
        sessionProviderInstanceId: null,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(true);
    expect(
      deriveMigrationModeAvailability({ isOriginLimited: true, isTurnStreaming: false }),
    ).toEqual({
      migrationDisabledReason: null,
      replayDisabledReason: null,
      briefDisabledReason: MIGRATION_BRIEF_LIMITED_REASON,
    });
    expect(
      deriveMigrationModeAvailability({ isOriginLimited: false, isTurnStreaming: true }),
    ).toEqual({
      migrationDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      replayDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      briefDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
    });
  });

  it("finds only the user message belonging to the latest failed turn", () => {
    const messages = [
      { id: "old", role: "user", turnId: "turn-old", text: "old" },
      { id: "failed", role: "user", turnId: "turn-failed", text: "retry me" },
    ];
    expect(
      findFailedTurnUserMessage({
        latestTurn: { turnId: "turn-failed", state: "error" },
        messages,
      }),
    ).toBe(messages[1]);
    expect(
      findFailedTurnUserMessage({
        latestTurn: { turnId: "turn-failed", state: "completed" },
        messages,
      }),
    ).toBeNull();
  });
});
