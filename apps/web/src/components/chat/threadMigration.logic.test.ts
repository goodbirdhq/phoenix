import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ProviderAvailability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MIGRATION_BRIEF_LIMITED_REASON,
  MIGRATION_STREAMING_BLOCK_REASON,
  deriveMigrationModeAvailability,
  findFailedTurnUserMessage,
  rankMigrationTargets,
  resolveRememberedMigrationTarget,
  shouldShowUsageLimitMigrationPopup,
  type MigrationTargetCandidate,
} from "./threadMigration.logic";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const originId = ProviderInstanceId.make("claude_work");

function availability(
  usedPercent: number | null,
  status: ProviderAvailability["status"] = "available",
): ProviderAvailability {
  return {
    status,
    source: "claude_cli_usage",
    windows:
      usedPercent === null
        ? []
        : [
            {
              kind: "session",
              usedPercent,
            },
          ],
  };
}

function candidate(input: {
  instanceId: string;
  driverKind?: typeof claude;
  displayName: string;
  status?: string;
}): MigrationTargetCandidate {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: input.driverKind ?? claude,
    displayName: input.displayName,
    enabled: true,
    isAvailable: true,
    status: input.status ?? "ready",
  };
}

describe("rankMigrationTargets", () => {
  it("puts same-driver accounts first and orders each tier by remaining quota", () => {
    const claudePersonal = candidate({
      instanceId: "claude_personal",
      displayName: "Claude Personal",
    });
    const claudeTeam = candidate({
      instanceId: "claude_team",
      displayName: "Claude Team",
    });
    const codexWork = candidate({
      instanceId: "codex_work",
      driverKind: codex,
      displayName: "Codex Work",
    });
    const targets = rankMigrationTargets({
      originInstanceId: originId,
      originDriverKind: claude,
      candidates: [
        candidate({ instanceId: originId, displayName: "Claude Work" }),
        claudePersonal,
        codexWork,
        claudeTeam,
      ],
      availabilityByInstanceId: new Map([
        [claudePersonal.instanceId, availability(70)],
        [claudeTeam.instanceId, availability(20)],
        [codexWork.instanceId, availability(5)],
      ]),
    });

    expect(targets.map((target) => target.instanceId)).toEqual([
      claudeTeam.instanceId,
      claudePersonal.instanceId,
      codexWork.instanceId,
    ]);
    expect(targets.map((target) => target.remainingQuotaPercent)).toEqual([80, 30, 95]);
  });

  it("drops unavailable or limited targets and keeps unknown quota last", () => {
    const unknown = candidate({ instanceId: "claude_unknown", displayName: "Unknown" });
    const limited = candidate({ instanceId: "claude_limited", displayName: "Limited" });
    const notReady = candidate({
      instanceId: "claude_starting",
      displayName: "Starting",
      status: "starting",
    });
    const known = candidate({ instanceId: "claude_ready", displayName: "Ready" });

    const targets = rankMigrationTargets({
      originInstanceId: originId,
      originDriverKind: claude,
      candidates: [unknown, limited, notReady, known],
      availabilityByInstanceId: new Map([
        [limited.instanceId, availability(100, "limited")],
        [known.instanceId, availability(45)],
      ]),
    });

    expect(targets.map((target) => target.instanceId)).toEqual([
      known.instanceId,
      unknown.instanceId,
    ]);
  });

  it("uses the remembered project target only while it remains eligible", () => {
    const first = candidate({ instanceId: "claude_a", displayName: "A" });
    const remembered = candidate({ instanceId: "claude_b", displayName: "B" });

    expect(resolveRememberedMigrationTarget([first, remembered], remembered.instanceId)).toBe(
      remembered,
    );
    expect(
      resolveRememberedMigrationTarget([first], ProviderInstanceId.make("no_longer_configured")),
    ).toBe(first);
  });
});

describe("shouldShowUsageLimitMigrationPopup", () => {
  it("shows for a limited status or a 100% window", () => {
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: originId,
        boundInstanceAvailability: availability(null, "limited"),
        sessionProviderInstanceId: originId,
        sessionErrorKind: null,
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: originId,
        boundInstanceAvailability: availability(100),
        sessionProviderInstanceId: originId,
        sessionErrorKind: null,
      }),
    ).toBe(true);
  });

  it("uses the typed error only when it belongs to the currently bound instance", () => {
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: originId,
        boundInstanceAvailability: null,
        sessionProviderInstanceId: originId,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(true);
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: ProviderInstanceId.make("claude_personal"),
        boundInstanceAvailability: null,
        sessionProviderInstanceId: originId,
        sessionErrorKind: "usage-limit",
      }),
    ).toBe(false);
  });

  it("stays hidden for generic errors and available quota", () => {
    expect(
      shouldShowUsageLimitMigrationPopup({
        boundInstanceId: originId,
        boundInstanceAvailability: availability(61),
        sessionProviderInstanceId: originId,
        sessionErrorKind: null,
      }),
    ).toBe(false);
  });
});

describe("findFailedTurnUserMessage", () => {
  it("selects the user message from the latest failed turn", () => {
    const failedTurnId = TurnId.make("failed-turn");
    const makeMessage = (text: string, turnId: typeof failedTurnId) => ({
      id: MessageId.make(text),
      role: "user" as const,
      text,
      turnId,
      streaming: false,
      createdAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z",
    });
    const failedMessage = makeMessage("please retry this", failedTurnId);

    expect(
      findFailedTurnUserMessage({
        latestTurn: {
          turnId: failedTurnId,
          state: "error",
          requestedAt: "2026-08-19T10:00:00.000Z",
          startedAt: "2026-08-19T10:00:01.000Z",
          completedAt: "2026-08-19T10:00:02.000Z",
          assistantMessageId: null,
        },
        messages: [makeMessage("older turn", TurnId.make("older-turn")), failedMessage],
      }),
    ).toBe(failedMessage);
  });

  it("does not retry a turn that did not fail", () => {
    expect(
      findFailedTurnUserMessage({
        latestTurn: {
          turnId: TurnId.make("completed-turn"),
          state: "completed",
          requestedAt: "2026-08-19T10:00:00.000Z",
          startedAt: "2026-08-19T10:00:01.000Z",
          completedAt: "2026-08-19T10:00:02.000Z",
          assistantMessageId: null,
        },
        messages: [],
      }),
    ).toBeNull();
  });
});

describe("deriveMigrationModeAvailability", () => {
  it("keeps replay available but explains why brief is unavailable at the limit", () => {
    expect(
      deriveMigrationModeAvailability({
        isOriginLimited: true,
        isTurnStreaming: false,
      }),
    ).toEqual({
      migrationDisabledReason: null,
      replayDisabledReason: null,
      briefDisabledReason: MIGRATION_BRIEF_LIMITED_REASON,
    });
  });

  it("blocks both modes while a turn is streaming", () => {
    expect(
      deriveMigrationModeAvailability({
        isOriginLimited: false,
        isTurnStreaming: true,
      }),
    ).toEqual({
      migrationDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      replayDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      briefDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
    });
  });
});
