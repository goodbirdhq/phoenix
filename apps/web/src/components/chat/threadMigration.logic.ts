import {
  ProjectId,
  ProviderInstanceId,
  type ProviderAvailability,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ChatMessage, Thread } from "../../types";

export const LAST_MIGRATION_TARGET_BY_PROJECT_KEY = "t3code:last-migration-target-by-project";
export const LastMigrationTargetByProjectSchema = Schema.Record(ProjectId, ProviderInstanceId);

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

/**
 * Same-driver instances are the least surprising continuation target. Within
 * each driver tier, use the most conservative remaining quota across reported
 * windows; unknown readings stay selectable but sort behind known capacity.
 */
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

export function resolveLimitBoundInstanceId(input: {
  readonly sessionProviderInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelSelectionInstanceId: ProviderInstanceId | null | undefined;
}): ProviderInstanceId | null {
  return input.sessionProviderInstanceId ?? input.threadModelSelectionInstanceId ?? null;
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
    input.sessionProviderInstanceId === input.boundInstanceId
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

export function resolveRememberedMigrationTarget<
  T extends { readonly instanceId: ProviderInstanceId },
>(targets: readonly T[], rememberedInstanceId: ProviderInstanceId | null | undefined): T | null {
  return targets.find((target) => target.instanceId === rememberedInstanceId) ?? targets[0] ?? null;
}

/** The retry gesture is intentionally limited to the latest failed turn. */
export function findFailedTurnUserMessage(
  thread: Pick<Thread, "latestTurn" | "messages"> | null | undefined,
): ChatMessage | null {
  if (!thread?.latestTurn || thread.latestTurn.state !== "error") return null;
  return (
    thread.messages.findLast(
      (message) => message.role === "user" && message.turnId === thread.latestTurn?.turnId,
    ) ?? null
  );
}
