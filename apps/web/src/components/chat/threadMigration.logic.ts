import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// The migration derivations are shared with mobile; this module keeps only
// what is genuinely web-local (the remembered-target persistence) and
// re-exports the rest so existing imports keep working.
export {
  MIGRATION_STREAMING_BLOCK_REASON,
  MIGRATION_BRIEF_LIMITED_REASON,
  type MigrationTargetCandidate,
  type RankedMigrationTarget,
  type MigrationModeAvailability,
  isProviderUsageLimited,
  providerRemainingQuotaPercent,
  rankMigrationTargets,
  shouldShowUsageLimitMigrationPopup,
  deriveMigrationModeAvailability,
  findFailedTurnUserMessage,
  resolveThreadBoundInstanceId as resolveLimitBoundInstanceId,
} from "@t3tools/client-runtime/usage/thread-migration";

export const LAST_MIGRATION_TARGET_BY_PROJECT_KEY = "t3code:last-migration-target-by-project";
export const LastMigrationTargetByProjectSchema = Schema.Record(ProjectId, ProviderInstanceId);

export function resolveRememberedMigrationTarget<
  T extends { readonly instanceId: ProviderInstanceId },
>(targets: readonly T[], rememberedInstanceId: ProviderInstanceId | null | undefined): T | null {
  return targets.find((target) => target.instanceId === rememberedInstanceId) ?? targets[0] ?? null;
}
