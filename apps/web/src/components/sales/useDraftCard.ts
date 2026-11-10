import {
  createDraftCard,
  type DraftCard,
  type DraftCardCommands,
} from "@t3tools/client-runtime/sales/draft-card";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { salesEnvironment, useApproveVersions } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * One draft card (`createDraftCard`) bound to an environment, read on mount and again when the
 * list reports a new hash for it. Pages key the panel by card, so a new card is a new mount.
 */
export function useDraftCard(props: {
  readonly environmentId: EnvironmentId;
  readonly activityId: string;
  readonly listedHash: string | null;
  readonly onChanged?: () => void;
  readonly onAnswerDiscarded?: (message: string) => void;
}): readonly [DraftCard, ReturnType<DraftCard["getState"]>] {
  const { environmentId, activityId } = props;
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  const unapprove = useAtomCommand(salesEnvironment.unapprove, { reportFailure: false });
  const edit = useAtomCommand(salesEnvironment.edit, { reportFailure: false });
  const discard = useAtomCommand(salesEnvironment.discard, { reportFailure: false });
  const dispatch = useAtomCommand(salesEnvironment.dispatch, { reportFailure: false });
  const approveVersions = useApproveVersions(environmentId);

  const commands: DraftCardCommands = {
    getQueueItem: () => getQueueItem({ environmentId, input: { activityId } }),
    edit: (input) => edit({ environmentId, input }),
    discard: (expectedHash) => discard({ environmentId, input: { activityId, expectedHash } }),
    unapprove: () => unapprove({ environmentId, input: { activityId } }),
    dispatch: (input) => dispatch({ environmentId, input }),
    approveVersions,
    confirm: (message) => requestConfirmDialog(message, { variant: "destructive" }),
    onChanged: () => props.onChanged?.(),
    onAnswerDiscarded: (message) => props.onAnswerDiscarded?.(message),
  };
  const [card] = useState(() => createDraftCard(commands, props.listedHash));
  // Later actions use this render's callbacks.
  useEffect(() => card.setCommands(commands));
  const state = useSyncExternalStore(card.subscribe, card.getState);

  useEffect(() => {
    void card.load();
  }, [card]);
  useEffect(() => {
    card.setListedHash(props.listedHash);
  }, [card, props.listedHash]);

  return [card, state];
}
