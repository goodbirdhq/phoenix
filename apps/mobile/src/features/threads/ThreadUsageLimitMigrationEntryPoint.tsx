import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MIGRATION_STREAMING_BLOCK_REASON,
  findFailedTurnUserMessage,
  rankMigrationTargets,
  resolveThreadBoundInstanceId,
  shouldShowUsageLimitMigrationPopup,
} from "@t3tools/client-runtime/usage/thread-migration";
import { subscriptionLimitResetLabel } from "@t3tools/client-runtime/usage/subscription-availability";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  isProviderAvailable,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ThreadMigrationHandoffMode,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { useAssetUrls } from "../../state/assets";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDetail } from "../../state/use-thread-detail";
import { threadEnvironment } from "../../state/threads";
import { useProviderAvailability } from "../../state/usage";
import { ThreadMigrationDialog } from "./ThreadMigrationDialog";
import {
  activeThreadsBoundToInstance,
  providerDisplayName,
  resolveMigrationTargetModel,
  threadTurnIsStreaming,
} from "./threadMigration";
import {
  UsageLimitMigrationPopup,
  type UsageLimitMigrationTarget,
} from "./UsageLimitMigrationPopup";

type LimitDialogRequest = {
  readonly target: UsageLimitMigrationTarget;
  readonly retryFailedTurn: boolean;
};

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The thread could not be migrated.";
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(new Error("Could not read the failed turn attachment.")),
    );
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read the failed turn attachment."));
      }
    });
    reader.readAsDataURL(blob);
  });
}

export const ThreadUsageLimitMigrationEntryPoint = memo(
  function ThreadUsageLimitMigrationEntryPoint(props: {
    readonly environmentId: EnvironmentId;
    readonly thread: OrchestrationThreadShell;
    readonly onMigrated: (selection: ModelSelection) => void;
  }) {
    const environments = useProviderAvailability();
    const threadShells = useThreadShells();
    const threadState = useThreadDetail({
      environmentId: props.environmentId,
      threadId: props.thread.id,
    });
    const thread = Option.getOrNull(threadState.data);
    const migrateThread = useAtomCommand(threadEnvironment.migrate, { reportFailure: false });
    const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
    const [selectedTargetId, setSelectedTargetId] = useState<ProviderInstanceId | null>(null);
    const [dialogRequest, setDialogRequest] = useState<LimitDialogRequest | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [isMigrationPending, setIsMigrationPending] = useState(false);
    const [isBulkPending, setIsBulkPending] = useState(false);

    const boundInstanceId = resolveThreadBoundInstanceId({
      sessionProviderInstanceId: props.thread.session?.providerInstanceId,
      threadModelSelectionInstanceId: props.thread.modelSelection.instanceId,
    });
    const environment = environments.find(
      (candidate) => candidate.environmentId === props.environmentId,
    );
    const availabilityByInstanceId = useMemo(
      () =>
        new Map(
          (environment?.providers ?? []).map(
            (entry) => [entry.instanceId, entry.availability] as const,
          ),
        ),
      [environment?.providers],
    );
    const originAvailability = boundInstanceId
      ? availabilityByInstanceId.get(boundInstanceId)
      : undefined;
    const visible = shouldShowUsageLimitMigrationPopup({
      boundInstanceId,
      boundInstanceAvailability: originAvailability,
      sessionProviderInstanceId: props.thread.session?.providerInstanceId ?? null,
      sessionErrorKind: props.thread.session?.lastErrorKind,
    });
    const serverProviders = environment?.serverProviders ?? [];
    const originProvider = serverProviders.find(
      (provider) => provider.instanceId === boundInstanceId,
    );
    const targets = useMemo<ReadonlyArray<UsageLimitMigrationTarget>>(() => {
      if (!boundInstanceId || !originProvider) return [];
      return rankMigrationTargets({
        originInstanceId: boundInstanceId,
        originDriverKind: originProvider.driver,
        availabilityByInstanceId,
        candidates: serverProviders.map((provider) => ({
          instanceId: provider.instanceId,
          driverKind: provider.driver,
          displayName: providerDisplayName(provider),
          enabled: provider.enabled,
          isAvailable: isProviderAvailable(provider),
          status: provider.status,
        })),
      }).flatMap((target) => {
        const targetProvider = serverProviders.find(
          (provider) => provider.instanceId === target.instanceId,
        );
        if (!targetProvider) return [];
        const model = resolveMigrationTargetModel({
          originDriverKind: originProvider.driver,
          targetProvider,
          currentModel: props.thread.modelSelection.model,
        });
        return model
          ? [
              {
                instanceId: target.instanceId,
                driver: target.driverKind,
                displayName: target.displayName,
                model,
                remainingQuotaPercent: target.remainingQuotaPercent,
              },
            ]
          : [];
      });
    }, [
      availabilityByInstanceId,
      boundInstanceId,
      originProvider,
      props.thread.modelSelection.model,
      serverProviders,
    ]);
    const selectedTarget =
      targets.find((target) => target.instanceId === selectedTargetId) ?? targets[0] ?? null;
    const limitedWindow = originAvailability?.windows
      .filter((window) => window.usedPercent >= 100)
      .toSorted((left, right) => right.usedPercent - left.usedPercent)[0];
    const resetLabel = limitedWindow ? subscriptionLimitResetLabel(limitedWindow) : null;
    const originName =
      originAvailability?.account?.displayName ??
      (originProvider ? providerDisplayName(originProvider) : String(boundInstanceId ?? "Account"));
    const isTurnStreaming = threadTurnIsStreaming(props.thread);

    const failedTurnMessage = findFailedTurnUserMessage(thread);
    const failedAttachmentResources = useMemo(
      () =>
        (failedTurnMessage?.attachments ?? []).map((attachment) => ({
          _tag: "attachment" as const,
          attachmentId: attachment.id,
        })),
      [failedTurnMessage?.attachments],
    );
    const failedAttachmentUrls = useAssetUrls(props.environmentId, failedAttachmentResources);
    const failedTurnCanRetry =
      failedTurnMessage !== null && failedAttachmentUrls.every((url) => url !== null);
    const retryUnavailableReason =
      failedTurnMessage === null
        ? "There is no failed turn message to retry."
        : failedTurnCanRetry
          ? null
          : "The failed turn's attachments are still loading.";

    const loadRetryAttachments = useCallback(async (): Promise<UploadChatImageAttachment[]> => {
      if (!failedTurnMessage) return [];
      return await Promise.all(
        (failedTurnMessage.attachments ?? []).map(async (attachment, index) => {
          const url = failedAttachmentUrls[index];
          if (!url) throw new Error(`Attachment ${attachment.name} is not ready to retry.`);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Could not reload attachment ${attachment.name}.`);
          const dataUrl = await readBlobAsDataUrl(await response.blob());
          return {
            type: "image" as const,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
          };
        }),
      );
    }, [failedAttachmentUrls, failedTurnMessage]);

    const openDialog = useCallback(
      (retryFailedTurn: boolean) => {
        if (!selectedTarget || isTurnStreaming) return;
        setDialogError(null);
        setDialogRequest({ target: selectedTarget, retryFailedTurn });
      },
      [isTurnStreaming, selectedTarget],
    );

    const closeDialog = useCallback(() => {
      if (isMigrationPending) return;
      setDialogError(null);
      setDialogRequest(null);
    }, [isMigrationPending]);

    const confirmMigration = useCallback(
      async (handoffMode: ThreadMigrationHandoffMode) => {
        if (!dialogRequest || !thread || isMigrationPending) return;
        setIsMigrationPending(true);
        setDialogError(null);

        let retryAttachments: UploadChatImageAttachment[] = [];
        if (dialogRequest.retryFailedTurn) {
          try {
            retryAttachments = await loadRetryAttachments();
          } catch (error) {
            setDialogError(actionErrorMessage(error));
            setIsMigrationPending(false);
            return;
          }
        }

        const migrationResult = await migrateThread({
          environmentId: props.environmentId,
          input: {
            threadId: props.thread.id,
            targetInstanceId: dialogRequest.target.instanceId,
            targetModel: dialogRequest.target.model,
            handoffMode,
            trigger: "limit-popup",
          },
        });
        if (migrationResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(migrationResult)) {
            setDialogError(actionErrorMessage(squashAtomCommandFailure(migrationResult)));
          }
          setIsMigrationPending(false);
          return;
        }

        const targetSelection: ModelSelection = {
          instanceId: dialogRequest.target.instanceId,
          model: dialogRequest.target.model,
        };
        props.onMigrated(targetSelection);
        const retryMessage = dialogRequest.retryFailedTurn ? failedTurnMessage : null;
        setDialogRequest(null);

        if (retryMessage) {
          const metadata = makeQueuedMessageMetadata();
          const retryResult = await startThreadTurn({
            environmentId: props.environmentId,
            input: {
              commandId: CommandId.make(metadata.commandId),
              threadId: props.thread.id,
              message: {
                messageId: MessageId.make(metadata.messageId),
                role: "user",
                text: retryMessage.text,
                attachments: retryAttachments,
              },
              modelSelection: targetSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: metadata.createdAt,
            },
          });
          if (retryResult._tag === "Failure" && !isAtomCommandInterrupted(retryResult)) {
            Alert.alert(
              `Switched to ${dialogRequest.target.displayName}, but retry failed`,
              actionErrorMessage(squashAtomCommandFailure(retryResult)),
            );
          }
        }
        setIsMigrationPending(false);
      },
      [
        dialogRequest,
        failedTurnMessage,
        isMigrationPending,
        loadRetryAttachments,
        migrateThread,
        props.environmentId,
        props.onMigrated,
        props.thread.id,
        startThreadTurn,
        thread,
      ],
    );

    const migrateAll = useCallback(async () => {
      if (
        !selectedTarget ||
        !boundInstanceId ||
        !originProvider ||
        isBulkPending ||
        isTurnStreaming
      ) {
        return;
      }
      const eligible = activeThreadsBoundToInstance({
        threads: threadShells,
        environmentId: props.environmentId,
        instanceId: boundInstanceId,
      });
      setIsBulkPending(true);
      const targetProvider = serverProviders.find(
        (provider) => provider.instanceId === selectedTarget.instanceId,
      );
      const inputs = targetProvider
        ? eligible.flatMap((candidate) => {
            const model = resolveMigrationTargetModel({
              originDriverKind: originProvider.driver,
              targetProvider,
              currentModel: candidate.modelSelection.model,
            });
            return model ? [{ candidate, model }] : [];
          })
        : [];
      const results = await Promise.all(
        inputs.map(({ candidate, model }) =>
          migrateThread({
            environmentId: candidate.environmentId,
            input: {
              threadId: candidate.id,
              targetInstanceId: selectedTarget.instanceId,
              targetModel: model,
              handoffMode: "replay",
              trigger: "limit-popup",
            },
          }),
        ),
      );
      const failures =
        eligible.length -
        inputs.length +
        results.filter((result) => result._tag === "Failure").length;
      const successes = eligible.length - failures;
      const currentInputIndex = inputs.findIndex(
        ({ candidate }) => candidate.id === props.thread.id,
      );
      const currentInput = inputs[currentInputIndex];
      const currentResult = results[currentInputIndex];
      if (currentInput && currentResult?._tag === "Success") {
        props.onMigrated({
          instanceId: selectedTarget.instanceId,
          model: currentInput.model,
        });
      }
      setIsBulkPending(false);
      Alert.alert(
        failures > 0
          ? `Switched ${successes} of ${eligible.length} active threads`
          : `Switched ${successes} active thread${successes === 1 ? "" : "s"}`,
        failures > 0
          ? "Threads that are streaming or cannot use the target model stayed on the limited account."
          : `They will continue on ${selectedTarget.displayName}.`,
      );
    }, [
      boundInstanceId,
      isBulkPending,
      isTurnStreaming,
      migrateThread,
      originProvider,
      props.environmentId,
      props.onMigrated,
      props.thread.id,
      selectedTarget,
      serverProviders,
      threadShells,
    ]);

    if (!visible) return null;

    return (
      <>
        <UsageLimitMigrationPopup
          originName={originName}
          resetLabel={resetLabel}
          targets={targets}
          selectedTarget={selectedTarget}
          failedTurnCanRetry={failedTurnCanRetry}
          retryUnavailableReason={retryUnavailableReason}
          isTurnStreaming={isTurnStreaming}
          streamingDisabledReason={isTurnStreaming ? MIGRATION_STREAMING_BLOCK_REASON : null}
          isBulkPending={isBulkPending}
          onSelectTarget={setSelectedTargetId}
          onSwitchAndRetry={() => openDialog(true)}
          onSwitchOnly={() => openDialog(false)}
          onSwitchAll={migrateAll}
        />
        <ThreadMigrationDialog
          open={dialogRequest !== null}
          sourceName={originName}
          targetName={dialogRequest?.target.displayName ?? ""}
          targetModel={dialogRequest?.target.model ?? ""}
          actionLabel={dialogRequest?.retryFailedTurn ? "Switch and retry" : "Switch thread"}
          isOriginLimited
          isTurnStreaming={isTurnStreaming}
          isPending={isMigrationPending}
          error={dialogError}
          onClose={closeDialog}
          onConfirm={confirmMigration}
        />
      </>
    );
  },
);
