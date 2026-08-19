import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isProviderUsageLimited } from "@t3tools/client-runtime/usage/thread-migration";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInstanceId,
  ThreadId,
  ThreadMigrationHandoffMode,
} from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useProviderAvailability } from "../../state/usage";
import { ThreadMigrationDialog } from "./ThreadMigrationDialog";
import { threadTurnIsStreaming } from "./threadMigration";

export interface ManualThreadMigrationRequest {
  readonly threadId: ThreadId;
  readonly boundInstanceId: ProviderInstanceId;
  readonly sourceName: string;
  readonly targetName: string;
  readonly targetSelection: ModelSelection;
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The thread could not be migrated.";
}

/**
 * Availability stays below this memo boundary so quota refreshes never
 * invalidate the composer, picker, or thread feed.
 */
export const ManualThreadMigrationEntryPoint = memo(
  function ManualThreadMigrationEntryPoint(props: {
    readonly environmentId: EnvironmentId;
    readonly thread: OrchestrationThreadShell;
    readonly request: ManualThreadMigrationRequest | null;
    readonly onClose: () => void;
    readonly onMigrated: (selection: ModelSelection) => void;
  }) {
    const environments = useProviderAvailability();
    const migrateThread = useAtomCommand(threadEnvironment.migrate, { reportFailure: false });
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const environment = environments.find(
      (candidate) => candidate.environmentId === props.environmentId,
    );
    const originAvailability = props.request
      ? environment?.providers.find((entry) => entry.instanceId === props.request?.boundInstanceId)
          ?.availability
      : null;
    const isOriginLimited = isProviderUsageLimited(originAvailability);
    const isTurnStreaming = threadTurnIsStreaming(props.thread);

    const close = useCallback(() => {
      if (isPending) return;
      setError(null);
      props.onClose();
    }, [isPending, props.onClose]);

    const confirm = useCallback(
      async (handoffMode: ThreadMigrationHandoffMode) => {
        const request = props.request;
        if (!request || isPending) return;
        setIsPending(true);
        setError(null);
        const result = await migrateThread({
          environmentId: props.environmentId,
          input: {
            threadId: request.threadId,
            targetInstanceId: request.targetSelection.instanceId,
            targetModel: request.targetSelection.model,
            handoffMode,
            trigger: "manual",
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setError(actionErrorMessage(squashAtomCommandFailure(result)));
          }
          setIsPending(false);
          return;
        }
        props.onMigrated(request.targetSelection);
        setIsPending(false);
        setError(null);
        props.onClose();
      },
      [
        isPending,
        migrateThread,
        props.environmentId,
        props.onClose,
        props.onMigrated,
        props.request,
      ],
    );

    const dialogProps = useMemo(
      () => ({
        sourceName: props.request?.sourceName ?? "",
        targetName: props.request?.targetName ?? "",
        targetModel: props.request?.targetSelection.model ?? "",
      }),
      [props.request],
    );

    return (
      <ThreadMigrationDialog
        open={props.request !== null}
        sourceName={dialogProps.sourceName}
        targetName={dialogProps.targetName}
        targetModel={dialogProps.targetModel}
        actionLabel="Switch thread"
        isOriginLimited={isOriginLimited}
        isTurnStreaming={isTurnStreaming}
        isPending={isPending}
        error={error}
        onClose={close}
        onConfirm={confirm}
      />
    );
  },
);
