import type {
  ProviderAvailability,
  ProviderAvailabilityWindow,
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

const hasConfirmedAvailability = (
  availability: ProviderAvailability | null | undefined,
): availability is ProviderAvailability =>
  availability !== null &&
  availability !== undefined &&
  availability.status !== "unknown" &&
  availability.stale === undefined;

export function resolveThreadBoundInstanceId(input: {
  readonly sessionProviderInstanceId: ProviderInstanceId | null | undefined;
  readonly threadModelSelectionInstanceId: ProviderInstanceId | null | undefined;
}): ProviderInstanceId | null {
  return input.sessionProviderInstanceId ?? input.threadModelSelectionInstanceId ?? null;
}

export function isProviderUsageLimited(
  availability: ProviderAvailability | null | undefined,
): boolean {
  if (!hasConfirmedAvailability(availability)) return false;
  return Boolean(
    availability.status === "limited" ||
    availability.windows.some((window) => window.usedPercent >= 100),
  );
}

const slugTokens = (value: string): string =>
  `-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}-`;

/**
 * Whether an exhausted window actually blocks `model`.
 *
 * Claude reports one weekly pool per model family alongside the session and
 * all-models windows. A spent Fable pool says nothing about a thread running
 * Opus, so only windows the model draws from count against it. A pool that
 * cannot be tied to the model — no model known, or a name that does not match —
 * is left out: a turn that really is blocked still fails with a typed
 * usage-limit error, which surfaces the popup on its own.
 */
export function windowConstrainsModel(
  window: ProviderAvailabilityWindow,
  model: string | null | undefined,
): boolean {
  if (window.kind !== "model-weekly" || !window.scope) return true;
  return model ? slugTokens(model).includes(slugTokens(window.scope)) : false;
}

/** Exhausted windows that constrain `model`, most spent first. */
export function modelUsageLimitWindows(
  availability: ProviderAvailability | null | undefined,
  model: string | null | undefined,
): readonly ProviderAvailabilityWindow[] {
  if (!hasConfirmedAvailability(availability)) return [];
  return availability.windows
    .filter((window) => window.usedPercent >= 100 && windowConstrainsModel(window, model))
    .toSorted((left, right) => right.usedPercent - left.usedPercent);
}

/**
 * The model-aware reading of {@link isProviderUsageLimited}. Falls back to the
 * coarse status only when no window explains it, so providers that report a
 * limit without windows still read as limited.
 */
export function isProviderUsageLimitedForModel(
  availability: ProviderAvailability | null | undefined,
  model: string | null | undefined,
): boolean {
  if (!hasConfirmedAvailability(availability)) return false;
  return availability.windows.some((window) => window.usedPercent >= 100)
    ? modelUsageLimitWindows(availability, model).length > 0
    : availability.status === "limited";
}

export function providerRemainingQuotaPercent(
  availability: ProviderAvailability | null | undefined,
): number | null {
  if (!hasConfirmedAvailability(availability) || availability.windows.length === 0) return null;
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
  /** The thread's model, so another model's spent pool never asks it to move. */
  readonly boundModel: string | null | undefined;
  readonly sessionProviderInstanceId: ProviderInstanceId | null;
  readonly sessionErrorKind: string | null | undefined;
}): boolean {
  if (input.boundInstanceId === null) return false;
  if (isProviderUsageLimitedForModel(input.boundInstanceAvailability, input.boundModel)) {
    return true;
  }
  return (
    input.sessionErrorKind === "usage-limit" &&
    (input.sessionProviderInstanceId === null ||
      input.sessionProviderInstanceId === input.boundInstanceId)
  );
}

/**
 * Identifies one usage-limit episode for a thread so a dismissal can be
 * remembered against it. A different thread, a different limited instance, or
 * a fresh reset window produces a new key and surfaces the popup again.
 */
export function usageLimitMigrationEpisodeKey(input: {
  readonly threadId: string;
  readonly boundInstanceId: ProviderInstanceId | null;
  readonly boundInstanceAvailability: ProviderAvailability | null | undefined;
  readonly boundModel: string | null | undefined;
}): string | null {
  if (input.boundInstanceId === null) return null;
  const resetsAt = modelUsageLimitWindows(input.boundInstanceAvailability, input.boundModel)
    .flatMap((window) => (window.resetsAt ? [window.resetsAt] : []))
    .toSorted()[0];
  return [input.threadId, input.boundInstanceId, resetsAt ?? "unknown"].join("\u0000");
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
