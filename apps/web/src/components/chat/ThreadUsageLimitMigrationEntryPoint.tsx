import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { subscriptionLimitResetLabel } from "@t3tools/client-runtime/usage/subscription-availability";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProviderAvailabilityEntry,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
  ThreadMigrationHandoffMode,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  readThreadShell,
  useEnvironmentThreadRefs,
  useThread,
  useThreadSession,
  useThreadShell,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import type { ChatMessage } from "../../types";
import { newMessageId } from "../../lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readFileAsDataUrl } from "../ChatView.logic";
import { ThreadMigrationDialog } from "./ThreadMigrationDialog";
import {
  UsageLimitMigrationPopup,
  type UsageLimitMigrationTarget,
} from "./UsageLimitMigrationPopup";
import {
  LAST_MIGRATION_TARGET_BY_PROJECT_KEY,
  LastMigrationTargetByProjectSchema,
  MIGRATION_STREAMING_BLOCK_REASON,
  deriveMigrationModeAvailability,
  findFailedTurnUserMessage,
  modelUsageLimitWindows,
  rankMigrationTargets,
  resolveRememberedMigrationTarget,
  shouldShowUsageLimitMigrationPopup,
  usageLimitMigrationEpisodeKey,
} from "./threadMigration.logic";
import { useEnvironmentQuery } from "../../state/query";

const EMPTY_PROVIDERS = Object.freeze([]);
const EMPTY_AVAILABILITY_ENTRIES: readonly ProviderAvailabilityEntry[] = Object.freeze([]);

type LimitMigrationDialogRequest = {
  readonly target: UsageLimitMigrationTarget;
  readonly retryFailedTurn: boolean;
};

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Small subscription boundary for the hard-limit entry point. ChatView passes
 * only durable route and session-binding identifiers; availability refreshes
 * and session state changes stop here instead of invalidating the chat tree.
 */
export const ThreadUsageLimitMigrationEntryPoint = memo(
  function ThreadUsageLimitMigrationEntryPoint(props: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
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
    const availabilityEntries = availabilityQuery.data?.providers ?? EMPTY_AVAILABILITY_ENTRIES;
    const originAvailability = availabilityEntries.find(
      (entry) => entry.instanceId === props.instanceId,
    )?.availability;
    const isVisible = shouldShowUsageLimitMigrationPopup({
      boundInstanceId: props.instanceId,
      boundInstanceAvailability: originAvailability,
      boundModel,
      sessionProviderInstanceId: session?.providerInstanceId ?? null,
      sessionErrorKind: session?.lastErrorKind ?? null,
    });
    // Dismissal is remembered against the limit episode, so the popup stays
    // closed for this limit but returns when the account is limited again.
    const episodeKey = usageLimitMigrationEpisodeKey({
      threadId: props.threadId,
      boundInstanceId: props.instanceId,
      boundInstanceAvailability: originAvailability,
      boundModel,
    });
    const [dismissedEpisodeKey, setDismissedEpisodeKey] = useState<string | null>(null);
    useEffect(() => {
      if (!isVisible && dismissedEpisodeKey !== null) setDismissedEpisodeKey(null);
    }, [dismissedEpisodeKey, isVisible]);
    const handleDismiss = useCallback(() => {
      setDismissedEpisodeKey(episodeKey);
    }, [episodeKey]);

    return isVisible && dismissedEpisodeKey !== episodeKey ? (
      <ThreadUsageLimitMigrationController
        threadId={props.threadId}
        environmentId={props.environmentId}
        instanceId={props.instanceId}
        availabilityEntries={availabilityEntries}
        onDismiss={handleDismiss}
      />
    ) : null;
  },
);

const ThreadUsageLimitMigrationController = memo(
  function ThreadUsageLimitMigrationController(props: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
    readonly availabilityEntries: readonly ProviderAvailabilityEntry[];
    readonly onDismiss: () => void;
  }) {
    const threadRef = useMemo(
      () => scopeThreadRef(props.environmentId, props.threadId),
      [props.environmentId, props.threadId],
    );
    const thread = useThread(threadRef, { waitForShell: true });
    const settings = useEnvironmentSettings(props.environmentId);
    const providerStatuses =
      useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? EMPTY_PROVIDERS;
    const threadRefs = useEnvironmentThreadRefs(props.environmentId);
    const migrateThread = useAtomCommand(threadEnvironment.migrate, { reportFailure: false });
    const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
    const setComposerModelSelection = useComposerDraftStore((store) => store.setModelSelection);
    const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
    const [lastTargetByProjectId, setLastTargetByProjectId] = useLocalStorage(
      LAST_MIGRATION_TARGET_BY_PROJECT_KEY,
      {},
      LastMigrationTargetByProjectSchema,
    );
    const [dialogRequest, setDialogRequest] = useState<LimitMigrationDialogRequest | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [isMigrationPending, setIsMigrationPending] = useState(false);
    const [isBulkPending, setIsBulkPending] = useState(false);

    const instanceEntries = useMemo(
      () =>
        sortProviderInstanceEntries(
          applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
        ),
      [providerStatuses, settings],
    );
    const availabilityByInstanceId = useMemo(
      () =>
        new Map(props.availabilityEntries.map((entry) => [entry.instanceId, entry.availability])),
      [props.availabilityEntries],
    );
    const originEntry =
      instanceEntries.find((entry) => entry.instanceId === props.instanceId) ?? null;
    const originAvailability = availabilityByInstanceId.get(props.instanceId);
    const isTurnStreaming =
      thread?.session?.status === "running" || thread?.latestTurn?.state === "running";

    const threadModel = thread?.modelSelection.model ?? null;
    const targets = useMemo<UsageLimitMigrationTarget[]>(() => {
      if (!threadModel || !originEntry) return [];
      return rankMigrationTargets({
        originInstanceId: props.instanceId,
        originDriverKind: originEntry.driverKind,
        candidates: instanceEntries,
        availabilityByInstanceId,
      }).flatMap((target) => {
        const model = resolveAppModelSelectionForInstance(
          target.instanceId,
          settings,
          providerStatuses,
          target.driverKind === originEntry.driverKind ? threadModel : null,
        );
        return model
          ? [
              {
                instanceId: target.instanceId,
                displayName: target.displayName,
                model,
                remainingQuotaPercent: target.remainingQuotaPercent,
              },
            ]
          : [];
      });
    }, [
      availabilityByInstanceId,
      instanceEntries,
      originEntry,
      props.instanceId,
      providerStatuses,
      settings,
      threadModel,
    ]);
    const projectId = thread?.projectId ?? null;
    const rememberedTargetId = projectId ? lastTargetByProjectId[projectId] : null;
    const selectedTarget = resolveRememberedMigrationTarget(targets, rememberedTargetId);
    const limitedWindow = modelUsageLimitWindows(originAvailability, threadModel)[0];
    const resetLabel = limitedWindow ? subscriptionLimitResetLabel(limitedWindow) : null;
    const originName =
      originAvailability?.account?.displayName ??
      originEntry?.displayName ??
      String(props.instanceId);

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
    const failedAttachmentUrlById = useMemo(
      () =>
        new Map(
          failedAttachmentResources.flatMap((resource, index) => {
            const url = failedAttachmentUrls[index];
            return url ? [[resource.attachmentId, url] as const] : [];
          }),
        ),
      [failedAttachmentResources, failedAttachmentUrls],
    );
    const failedTurnAttachmentsReady = Boolean(
      failedTurnMessage &&
      (failedTurnMessage.attachments ?? []).every((attachment) =>
        failedAttachmentUrlById.has(attachment.id),
      ),
    );
    const failedTurnCanRetry = failedTurnMessage !== null && failedTurnAttachmentsReady;
    const retryUnavailableReason =
      failedTurnMessage === null
        ? "There is no failed turn message to retry."
        : failedTurnAttachmentsReady
          ? null
          : "The failed turn's attachments are still loading.";

    const rememberTarget = useCallback(
      (instanceId: ProviderInstanceId) => {
        if (!projectId) return;
        setLastTargetByProjectId((current) => ({
          ...current,
          [projectId]: instanceId,
        }));
      },
      [projectId, setLastTargetByProjectId],
    );

    const handleTargetSelect = useCallback(
      (instanceId: ProviderInstanceId) => {
        rememberTarget(instanceId);
      },
      [rememberTarget],
    );

    const openDialog = useCallback(
      (retryFailedTurn: boolean) => {
        if (!selectedTarget) return;
        setDialogError(null);
        setDialogRequest({ target: selectedTarget, retryFailedTurn });
      },
      [selectedTarget],
    );
    const handleSwitchAndRetry = useCallback(() => openDialog(true), [openDialog]);
    const handleSwitchOnly = useCallback(() => openDialog(false), [openDialog]);
    const handleDialogOpenChange = useCallback(
      (open: boolean) => {
        if (!open && !isMigrationPending) {
          setDialogRequest(null);
          setDialogError(null);
        }
      },
      [isMigrationPending],
    );

    const loadRetryAttachments = useCallback(
      async (message: ChatMessage) =>
        await Promise.all(
          (message.attachments ?? []).map(async (attachment) => {
            const previewUrl = failedAttachmentUrlById.get(attachment.id);
            if (!previewUrl) {
              throw new Error(`Attachment ${attachment.name} is not ready to retry.`);
            }
            const response = await fetch(previewUrl);
            if (!response.ok) {
              throw new Error(`Could not reload attachment ${attachment.name}.`);
            }
            const blob = await response.blob();
            const file = new File([blob], attachment.name, { type: attachment.mimeType });
            return {
              type: "image" as const,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl: await readFileAsDataUrl(file),
            };
          }),
        ),
      [failedAttachmentUrlById],
    );

    const handleMigrationConfirm = useCallback(
      async (handoffMode: ThreadMigrationHandoffMode) => {
        if (!dialogRequest || !thread) return;
        const modeAvailability = deriveMigrationModeAvailability({
          isOriginLimited: true,
          isTurnStreaming,
        });
        const disabledReason =
          handoffMode === "brief"
            ? modeAvailability.briefDisabledReason
            : modeAvailability.replayDisabledReason;
        if (disabledReason) {
          setDialogError(disabledReason);
          return;
        }

        setIsMigrationPending(true);
        setDialogError(null);

        let retryMessage: ChatMessage | null = null;
        let retryAttachments: Awaited<ReturnType<typeof loadRetryAttachments>> = [];
        if (dialogRequest.retryFailedTurn) {
          retryMessage = findFailedTurnUserMessage(thread);
          if (!retryMessage) {
            setDialogError("The failed turn is no longer available to retry.");
            setIsMigrationPending(false);
            return;
          }
          const attachmentsResult = await settlePromise(() => loadRetryAttachments(retryMessage!));
          if (attachmentsResult._tag === "Failure") {
            setDialogError(actionErrorMessage(squashAtomCommandFailure(attachmentsResult)));
            setIsMigrationPending(false);
            return;
          }
          retryAttachments = attachmentsResult.value;
        }

        const migrationResult = await migrateThread({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
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

        const targetModelSelection: ModelSelection = {
          instanceId: dialogRequest.target.instanceId,
          model: dialogRequest.target.model,
        };
        setComposerModelSelection(threadRef, targetModelSelection);
        setStickyModelSelection(targetModelSelection);
        rememberTarget(dialogRequest.target.instanceId);
        setDialogRequest(null);

        if (retryMessage) {
          const retryResult = await startThreadTurn({
            environmentId: props.environmentId,
            input: {
              threadId: props.threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: retryMessage.text,
                attachments: retryAttachments,
              },
              modelSelection: targetModelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: new Date().toISOString(),
            },
          });
          if (retryResult._tag === "Failure" && !isAtomCommandInterrupted(retryResult)) {
            toastManager.add(
              stackedThreadToast({
                type: "warning",
                title: `Switched to ${dialogRequest.target.displayName}, but retry failed`,
                description: actionErrorMessage(squashAtomCommandFailure(retryResult)),
              }),
            );
          }
        }

        setIsMigrationPending(false);
      },
      [
        dialogRequest,
        isTurnStreaming,
        loadRetryAttachments,
        migrateThread,
        props.environmentId,
        props.threadId,
        rememberTarget,
        setComposerModelSelection,
        setStickyModelSelection,
        startThreadTurn,
        thread,
        threadRef,
      ],
    );

    const handleBulkMigration = useCallback(async () => {
      if (!selectedTarget || isBulkPending) return;
      if (isTurnStreaming) {
        toastManager.add({
          type: "warning",
          title: "Threads cannot migrate mid-turn",
          description: MIGRATION_STREAMING_BLOCK_REASON,
        });
        return;
      }

      const eligibleThreads = threadRefs.flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell &&
          shell.archivedAt === null &&
          shell.modelSelection.instanceId === props.instanceId
          ? [{ ref, shell }]
          : [];
      });
      if (eligibleThreads.length === 0) return;

      setIsBulkPending(true);
      const inputs = eligibleThreads.flatMap(({ ref, shell }) => {
        const targetModel = resolveAppModelSelectionForInstance(
          selectedTarget.instanceId,
          settings,
          providerStatuses,
          shell.modelSelection.model,
        );
        return targetModel ? [{ ref, shell, targetModel }] : [];
      });
      const results = await Promise.all(
        inputs.map(({ ref, shell, targetModel }) =>
          migrateThread({
            environmentId: ref.environmentId,
            input: {
              threadId: shell.id,
              targetInstanceId: selectedTarget.instanceId,
              targetModel,
              handoffMode: "replay",
              trigger: "limit-popup",
            },
          }),
        ),
      );
      const failureCount =
        eligibleThreads.length -
        inputs.length +
        results.filter((result) => result._tag === "Failure").length;
      const successCount = eligibleThreads.length - failureCount;

      rememberTarget(selectedTarget.instanceId);
      toastManager.add(
        stackedThreadToast({
          type: failureCount > 0 ? "warning" : "success",
          title:
            failureCount > 0
              ? `Switched ${successCount} of ${eligibleThreads.length} active threads`
              : `Switched ${successCount} active thread${successCount === 1 ? "" : "s"}`,
          description:
            failureCount > 0
              ? "Threads that are streaming or cannot use the target model stayed on the limited account."
              : `They will continue on ${selectedTarget.displayName}.`,
        }),
      );
      setIsBulkPending(false);
    }, [
      isBulkPending,
      isTurnStreaming,
      migrateThread,
      props.instanceId,
      providerStatuses,
      rememberTarget,
      selectedTarget,
      settings,
      threadRefs,
    ]);

    return (
      <>
        <UsageLimitMigrationPopup
          originName={originName}
          resetLabel={resetLabel}
          targets={targets}
          selectedTarget={selectedTarget}
          failedTurnCanRetry={failedTurnCanRetry}
          retryUnavailableReason={retryUnavailableReason}
          isBulkPending={isBulkPending}
          bulkDisabledReason={isTurnStreaming ? MIGRATION_STREAMING_BLOCK_REASON : null}
          onSelectTarget={handleTargetSelect}
          onSwitchAndRetry={handleSwitchAndRetry}
          onSwitchOnly={handleSwitchOnly}
          onSwitchAll={handleBulkMigration}
          onDismiss={props.onDismiss}
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
          onOpenChange={handleDialogOpenChange}
          onConfirm={handleMigrationConfirm}
        />
      </>
    );
  },
);
