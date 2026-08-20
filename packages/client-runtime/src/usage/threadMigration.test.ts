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
  isProviderUsageLimitedForModel,
  modelUsageLimitWindows,
  shouldShowUsageLimitMigrationPopup,
  usageLimitMigrationEpisodeKey,
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

  it("counts a spent per-model pool only against the models that draw from it", () => {
    // Claude renders one weekly pool per model family beside the shared windows.
    const fableSpent: ProviderAvailability = {
      status: "limited",
      source: "claude_cli_usage",
      observedAt: "2026-08-19T12:00:00.000Z",
      windows: [
        { kind: "session", label: "Current session", usedPercent: 22 },
        { kind: "weekly", label: "All models", scope: "all-models", usedPercent: 61 },
        {
          kind: "model-weekly",
          label: "Fable",
          scope: "fable",
          usedPercent: 100,
          resetsAt: "2026-08-23T11:00:00.000Z",
        },
      ],
    };

    expect(isProviderUsageLimitedForModel(fableSpent, "claude-fable-5")).toBe(true);
    expect(isProviderUsageLimitedForModel(fableSpent, "claude-opus-5[1m]")).toBe(false);
    // A model we cannot tie to the pool is not asked to move; a blocked turn
    // still fails with a typed usage-limit error, which shows the popup anyway.
    expect(isProviderUsageLimitedForModel(fableSpent, null)).toBe(false);
    expect(modelUsageLimitWindows(fableSpent, "claude-opus-5")).toEqual([]);
    expect(modelUsageLimitWindows(fableSpent, "claude-fable-5")).toEqual([fableSpent.windows[2]]);

    // Nearby version slugs must not collide.
    const opus45Spent: ProviderAvailability = {
      ...fableSpent,
      windows: [{ kind: "model-weekly", label: "Opus 4.5", scope: "opus-4-5", usedPercent: 100 }],
    };
    expect(isProviderUsageLimitedForModel(opus45Spent, "claude-opus-4-5-20250929")).toBe(true);
    expect(isProviderUsageLimitedForModel(opus45Spent, "claude-opus-5")).toBe(false);

    // Shared windows still limit every model, and a status-only limit stands.
    expect(isProviderUsageLimitedForModel(availability(100), "claude-opus-5")).toBe(true);
    expect(
      isProviderUsageLimitedForModel(
        { status: "limited", source: "codex_app_server", windows: [] },
        "gpt-5.6-sol",
      ),
    ).toBe(true);

    const instanceId = ProviderInstanceId.make("origin");
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: fableSpent,
        boundModel: "claude-opus-5",
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: null,
      }),
    ).toBe(false);
    // Until that thread's own turn fails on the limit.
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: fableSpent,
        boundModel: "claude-opus-5",
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(true);
  });

  it("keys a dismissal to one thread, instance, and reset window", () => {
    const origin = ProviderInstanceId.make("origin");
    const limited = (resetsAt?: string): ProviderAvailability => ({
      status: "limited",
      source: "codex_app_server",
      observedAt: "2026-08-19T12:00:00.000Z",
      windows: [{ kind: "session", usedPercent: 100, ...(resetsAt ? { resetsAt } : {}) }],
    });
    const key = (threadId: string, instanceId: ProviderInstanceId, resetsAt?: string) =>
      usageLimitMigrationEpisodeKey({
        threadId,
        boundInstanceId: instanceId,
        boundInstanceAvailability: limited(resetsAt),
        boundModel: "claude-opus-5",
      });
    const reset = "2026-08-22T12:00:00.000Z";

    expect(key("thread-a", origin, reset)).toBe(key("thread-a", origin, reset));
    // A dismissal on one thread must not silence another.
    expect(key("thread-a", origin, reset)).not.toBe(key("thread-b", origin, reset));
    // A new limit window after the reset surfaces the popup again.
    expect(key("thread-a", origin, reset)).not.toBe(
      key("thread-a", origin, "2026-08-29T12:00:00.000Z"),
    );
    expect(key("thread-a", origin, reset)).not.toBe(
      key("thread-a", ProviderInstanceId.make("other"), reset),
    );
    // Windows without a reset time still produce a stable key.
    expect(key("thread-a", origin)).toBe(key("thread-a", origin));
    expect(
      usageLimitMigrationEpisodeKey({
        threadId: "thread-a",
        boundInstanceId: null,
        boundInstanceAvailability: limited(reset),
        boundModel: "claude-opus-5",
      }),
    ).toBeNull();
  });

  it("shows on native or typed usage-limit signals and gates handoff modes", () => {
    const instanceId = ProviderInstanceId.make("origin");
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(100),
        boundModel: "claude-opus-5",
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: null,
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(10),
        boundModel: "claude-opus-5",
        sessionProviderInstanceId: instanceId,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: instanceId,
        boundInstanceAvailability: availability(10),
        boundModel: "claude-opus-5",
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
