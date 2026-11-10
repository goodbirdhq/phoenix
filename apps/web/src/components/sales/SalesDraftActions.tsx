import {
  type DraftCard,
  type DraftCardState,
  isDirty,
} from "@t3tools/client-runtime/sales/draft-card";
import { checkSigning, thisDeviceDescription } from "@t3tools/client-runtime/sales/devices";
import { cardActions } from "@t3tools/client-runtime/sales/outreach";
import {
  type SalesDispatchAction,
  type SalesQueueItemDetail,
  safeSalesNote,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import type { SalesDeviceView } from "./SalesDraftPanel";

/** The buttons for what a person can do to a draft in its state, and the redraft form. */
export function SalesDraftActions(props: {
  readonly card: DraftCard;
  readonly state: DraftCardState;
  readonly detail: SalesQueueItemDetail;
  readonly canAct: boolean;
  readonly device: SalesDeviceView;
  readonly approveLabel: string | undefined;
  readonly discardLabel: string | undefined;
  readonly allowResearch: boolean;
  readonly onEdit: () => void;
}) {
  const { card, state, detail, device } = props;
  if (!props.canAct) {
    return (
      <p className="text-xs text-muted-foreground">
        Add the engine's action token in Settings › Integrations to act on drafts.
      </p>
    );
  }
  const actions = cardActions(detail);
  const { redraft, research } = detail.dispatch;
  const busy = state.busy !== null;
  const { refusal } = checkSigning(device);
  return (
    <>
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          {actions.approve ? (
            <Button
              size="sm"
              disabled={busy || isDirty(state) || refusal !== null}
              onClick={() => void card.approve(device)}
            >
              {state.busy === "approve" ? "Signing…" : (props.approveLabel ?? "Approve")}
            </Button>
          ) : null}
          {actions.unapprove ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void card.unapprove()}
            >
              Unapprove
            </Button>
          ) : null}
          {actions.edit ? (
            <Button size="sm" variant="outline" onClick={props.onEdit}>
              Edit
            </Button>
          ) : null}
          {redraft ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={card.toggleRedraft}>
              {redraft.title}
            </Button>
          ) : null}
          {props.allowResearch && research ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void card.research()}
            >
              {research.title}
            </Button>
          ) : null}
          {actions.discard ? (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void card.discard(props.discardLabel ?? "Discard this draft")}
            >
              {props.discardLabel ?? "Discard"}
            </Button>
          ) : null}
        </div>
        {actions.approve ? (
          <p className="text-xs text-muted-foreground">
            {refusal?.description ?? thisDeviceDescription(device.state, device.key)}
          </p>
        ) : null}
      </div>
      {redraft && state.redraftNote !== null ? (
        <RedraftForm
          card={card}
          plan={redraft}
          note={state.redraftNote}
          busy={state.busy}
          activityId={detail.activityId}
        />
      ) : null}
    </>
  );
}

function RedraftForm(props: {
  readonly card: DraftCard;
  readonly plan: SalesDispatchAction;
  readonly note: string;
  readonly busy: DraftCardState["busy"];
  readonly activityId: string;
}) {
  const { card, plan, note } = props;
  return (
    <form
      className="grid gap-2 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void card.startRedraft();
      }}
    >
      <Label htmlFor={`sales-redraft-${props.activityId}`}>What should the new draft do?</Label>
      <Textarea
        id={`sales-redraft-${props.activityId}`}
        size="sm"
        value={note}
        onChange={(event) => card.setRedraftNote(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {plan.discardFirst
          ? "This discards this draft, then starts a run that drafts a new one with your note."
          : "This starts a run in the sales agents project that rewrites this draft with your note."}
      </p>
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={card.toggleRedraft}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={props.busy !== null || (plan.noteRequired && safeSalesNote(note).length === 0)}
        >
          {props.busy === "dispatch" ? "Starting…" : "Start redraft"}
        </Button>
      </div>
    </form>
  );
}
