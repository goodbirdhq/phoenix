import type {
  ProviderAvailability,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const MIGRATION_STREAMING_BLOCK_REASON =
  "Wait for the current turn to finish or interrupt it before migrating this thread.";
export const MIGRATION_BRIEF_LIMITED_REASON =
  "The current account is at its usage limit, so it cannot create a handoff brief.";

export interface MigrationTargetCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly status: string;
}

export interface RankedMigrationTarget extends MigrationTargetCandidate {
  readonly remainingQuotaPercent: number | null;
}

export interface MigrationModeAvailability {
  readonly migrationDisabledReason: string | null;
  readonly replayDisabledReason: string | null;
  readonly briefDisabledReason: string | null;
}

export function resolveThreadBoundInstanceId(input: {
  readonly sessionProviderInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelSelectionInstanceId: ProviderInstanceId | null | undefined;
}): ProviderInstanceId | null {
  return input.sessionProviderInstanceId ?? input.threadModelSelectionInstanceId ?? null;
}

export function isProviderUsageLimited(
  availability: ProviderAvailability | null | undefined,
): boolean {
  return Boolean(
    availability &&
    (availability.status === "limited" ||
      availability.windows.some((window) => window.usedPercent >= 100)),
  );
}

export function providerRemainingQuotaPercent(
  availability: ProviderAvailability | null | undefined,
): number | null {
  if (!availability || availability.windows.length === 0) return null;
  const mostUsedWindow = Math.max(...availability.windows.map((window) => window.usedPercent));
  return Math.max(0, 100 - mostUsedWindow);
}

/** Same-driver instances rank first, then the instance with the most conservative quota headroom. */
export function rankMigrationTargets(input: {
  readonly originInstanceId: ProviderInstanceId;
  readonly originDriverKind: ProviderDriverKind;
  readonly candidates: readonly MigrationTargetCandidate[];
  readonly availabilityByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderAvailability>;
}): RankedMigrationTarget[] {
  return input.candidates
    .flatMap((candidate): RankedMigrationTarget[] => {
      if (
        candidate.instanceId === input.originInstanceId ||
        !candidate.enabled ||
        !candidate.isAvailable ||
        candidate.status !== "ready"
      ) {
        return [];
      }
      const availability = input.availabilityByInstanceId.get(candidate.instanceId);
      if (isProviderUsageLimited(availability)) return [];
      return [
        {
          ...candidate,
          remainingQuotaPercent: providerRemainingQuotaPercent(availability),
        },
      ];
    })
    .toSorted((left, right) => {
      const leftSameDriver = left.driverKind === input.originDriverKind;
      const rightSameDriver = right.driverKind === input.originDriverKind;
      if (leftSameDriver !== rightSameDriver) return leftSameDriver ? -1 : 1;
      if (left.remainingQuotaPercent !== right.remainingQuotaPercent) {
        if (left.remainingQuotaPercent === null) return 1;
        if (right.remainingQuotaPercent === null) return -1;
        return right.remainingQuotaPercent - left.remainingQuotaPercent;
      }
      return (
        left.displayName.localeCompare(right.displayName) ||
        left.instanceId.localeCompare(right.instanceId)
      );
    });
}

export function shouldShowUsageLimitMigrationPopup(input: {
  readonly boundInstanceId: ProviderInstanceId | null;
  readonly boundInstanceAvailability: ProviderAvailability | null | undefined;
  readonly sessionProviderInstanceId: ProviderInstanceId | null;
  readonly sessionErrorKind: string | null | undefined;
}): boolean {
  if (input.boundInstanceId === null) return false;
  if (isProviderUsageLimited(input.boundInstanceAvailability)) return true;
  return (
    input.sessionErrorKind === "usage-limit" &&
    (input.sessionProviderInstanceId === null ||
      input.sessionProviderInstanceId === input.boundInstanceId)
  );
}

export function deriveMigrationModeAvailability(input: {
  readonly isOriginLimited: boolean;
  readonly isTurnStreaming: boolean;
}): MigrationModeAvailability {
  if (input.isTurnStreaming) {
    return {
      migrationDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      replayDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
      briefDisabledReason: MIGRATION_STREAMING_BLOCK_REASON,
    };
  }
  return {
    migrationDisabledReason: null,
    replayDisabledReason: null,
    briefDisabledReason: input.isOriginLimited ? MIGRATION_BRIEF_LIMITED_REASON : null,
  };
}

export function findFailedTurnUserMessage<
  Message extends { readonly role: string; readonly turnId?: string | null },
>(
  thread:
    | {
        readonly latestTurn: { readonly turnId: string; readonly state: string } | null;
        readonly messages: readonly Message[];
      }
    | null
    | undefined,
): Message | null {
  if (!thread?.latestTurn || thread.latestTurn.state !== "error") return null;
  return (
    thread.messages.findLast(
      (message) => message.role === "user" && message.turnId === thread.latestTurn?.turnId,
    ) ?? null
  );
}
