import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadBoundInstanceId } from "@t3tools/client-runtime/usage/thread-migration";
import {
  isProviderAvailable,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

import type { ProviderGroup } from "../../lib/modelOptions";

export function providerDisplayName(
  provider: Pick<ServerProvider, "displayName" | "driver" | "instanceId">,
): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return String(provider.instanceId);
}

export function readyThreadProviderGroups(input: {
  readonly groups: ReadonlyArray<ProviderGroup>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly boundInstanceId: ProviderInstanceId;
}): ReadonlyArray<ProviderGroup> {
  const readyInstanceIds = new Set(
    input.providers
      .filter(
        (provider) =>
          provider.status === "ready" &&
          provider.enabled &&
          provider.installed &&
          provider.auth.status !== "unauthenticated" &&
          isProviderAvailable(provider),
      )
      .map((provider) => provider.instanceId),
  );
  return input.groups.filter(
    (group) =>
      group.providerKey === input.boundInstanceId ||
      readyInstanceIds.has(ProviderInstanceId.make(group.providerKey)),
  );
}

export function threadTurnIsStreaming(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): boolean {
  return thread.session?.status === "running" || thread.latestTurn?.state === "running";
}
export function threadHasStarted(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session">,
): boolean {
  return thread.latestTurn !== null || thread.session !== null;
}

export function resolveMigrationTargetModel(input: {
  readonly originDriverKind: ProviderDriverKind;
  readonly targetProvider: ServerProvider;
  readonly currentModel: string;
}): string | null {
  const preferred =
    input.targetProvider.driver === input.originDriverKind
      ? input.targetProvider.models.find((model) => model.slug === input.currentModel)
      : null;
  return (
    preferred?.slug ??
    input.targetProvider.models.find((model) => model.isDefault === true && !model.isLegacy)
      ?.slug ??
    input.targetProvider.models.find((model) => !model.isLegacy)?.slug ??
    input.targetProvider.models[0]?.slug ??
    null
  );
}

export function activeThreadsBoundToInstance(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}): ReadonlyArray<EnvironmentThreadShell> {
  return input.threads.filter((thread) => {
    if (thread.environmentId !== input.environmentId || thread.archivedAt !== null) {
      return false;
    }
    return (
      resolveThreadBoundInstanceId({
        sessionProviderInstanceId: thread.session?.providerInstanceId,
        threadModelSelectionInstanceId: thread.modelSelection.instanceId,
      }) === input.instanceId
    );
  });
}
