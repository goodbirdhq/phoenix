import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ThreadMigrationHandoffMode,
} from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useThreadSession, useThreadShell } from "../../state/entities";
import { isProviderUsageLimitedForModel } from "./threadMigration.logic";
import { ThreadMigrationDialog } from "./ThreadMigrationDialog";

/**
 * Keeps origin availability and typed session-limit subscriptions below the
 * chat hot path. Stable scalar props let React skip this boundary while the
 * surrounding timeline streams.
 */
export const ThreadMigrationDialogBoundary = memo(function ThreadMigrationDialogBoundary(props: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly open: boolean;
  readonly sourceName: string;
  readonly targetName: string;
  readonly targetModel: string;
  readonly actionLabel: string;
  readonly isTurnStreaming: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (handoffMode: ThreadMigrationHandoffMode) => void;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const session = useThreadSession(threadRef);
  const boundModel = useThreadShell(threadRef)?.modelSelection.model ?? null;
  const availabilityQuery = useEnvironmentQuery(
    serverEnvironment.providerAvailability({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const availability = availabilityQuery.data?.providers.find(
    (entry) => entry.instanceId === props.instanceId,
  )?.availability;
  // Model-aware: another model's spent weekly pool must not disable the brief
  // handoff on a thread that can still spend the origin account.
  const isOriginLimited =
    isProviderUsageLimitedForModel(availability, boundModel) ||
    (session?.providerInstanceId === props.instanceId && session.lastErrorKind === "usage-limit");

  return (
    <ThreadMigrationDialog
      open={props.open}
      sourceName={props.sourceName}
      targetName={props.targetName}
      targetModel={props.targetModel}
      actionLabel={props.actionLabel}
      isOriginLimited={isOriginLimited}
      isTurnStreaming={props.isTurnStreaming}
      isPending={props.isPending}
      error={props.error}
      onOpenChange={props.onOpenChange}
      onConfirm={props.onConfirm}
    />
  );
});
