import {
  createDraftCard,
  type DraftCard,
  type DraftCardCommands,
  isDirty,
} from "@t3tools/client-runtime/sales/draft-card";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentConnected } from "../../state/environments";
import { salesEnvironment, useApproveVersions } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * One draft card (`createDraftCard`) bound to an environment, read once connected, again on a
 * reconnect unless mid-edit, and when the list reports a new hash for it. Pages key the panel by
 * card, so a new card is a new mount.
 */
export function useDraftCard(props: {
  readonly environmentId: EnvironmentId;
  readonly activityId: string;
  readonly listedHash: string | null;
  readonly onChanged?: () => void;
  readonly onDiscardedWithoutRun?: (message: string) => void;
}): readonly [DraftCard, ReturnType<DraftCard["getState"]>] {
  const { environmentId, activityId } = props;
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  const hold = useAtomCommand(salesEnvironment.hold, { reportFailure: false });
  const resume = useAtomCommand(salesEnvironment.resume, { reportFailure: false });
  const edit = useAtomCommand(salesEnvironment.edit, { reportFailure: false });
  const discard = useAtomCommand(salesEnvironment.discard, { reportFailure: false });
  const dispatch = useAtomCommand(salesEnvironment.dispatch, { reportFailure: false });
  const approveVersions = useApproveVersions(environmentId);

  const commands: DraftCardCommands = {
    getQueueItem: () => getQueueItem({ environmentId, input: { activityId } }),
    edit: (input) => edit({ environmentId, input }),
    discard: (expectedHash) => discard({ environmentId, input: { activityId, expectedHash } }),
    hold: () => hold({ environmentId, input: { activityId } }),
    resume: (expectedHash) => resume({ environmentId, input: { activityId, expectedHash } }),
    dispatch: (input) => dispatch({ environmentId, input }),
    approveVersions,
    confirm: (message) => requestConfirmDialog(message, { variant: "destructive" }),
    onChanged: () => props.onChanged?.(),
    onDiscardedWithoutRun: (message) => props.onDiscardedWithoutRun?.(message),
  };
  const [card] = useState(() => createDraftCard(commands, props.listedHash));
  // Later actions use this render's callbacks.
  useEffect(() => card.setCommands(commands));
  const state = useSyncExternalStore(card.subscribe, card.getState);

  const connected = useEnvironmentConnected(environmentId);
  useEffect(() => {
    if (connected && !isDirty(card.getState())) void card.load();
  }, [card, connected]);
  useEffect(() => {
    card.setListedHash(props.listedHash);
  }, [card, props.listedHash]);

  return [card, state];
}
