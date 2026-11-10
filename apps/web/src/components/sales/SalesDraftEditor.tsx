import { displayedDraft } from "@t3tools/client-runtime/sales/approval";
import { cardActions } from "@t3tools/client-runtime/sales/outreach";
import {
  type DraftCard,
  type DraftCardState,
  isDirty,
} from "@t3tools/client-runtime/sales/draft-card";
import type { SalesQueueItemDetail } from "@t3tools/contracts";
import type { Ref } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/** A draft's subject and body, shown exactly as hashed, and edited in place. */
export function SalesDraftEditor(props: {
  readonly card: DraftCard;
  readonly state: DraftCardState;
  readonly detail: SalesQueueItemDetail;
  readonly canAct: boolean;
  readonly bodyRef: Ref<HTMLTextAreaElement>;
}) {
  const { card, state, detail, bodyRef } = props;
  const shown = displayedDraft(detail);
  const subject = state.subjectDraft ?? shown.subject;
  const body = state.bodyDraft ?? shown.body;
  const editable = props.canAct && cardActions(detail).edit && state.busy === null;
  const id = detail.activityId;

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`sales-subject-${id}`}>Subject</Label>
        {detail.threaded || (state.subjectDraft === null && /[\r\n]/u.test(subject)) ? (
          // Shown as text, line breaks and all: a one-line field would hide what is hashed.
          <p id={`sales-subject-${id}`} className="text-sm whitespace-pre-wrap">
            {subject}{" "}
            <span className="text-xs text-muted-foreground">
              {detail.threaded
                ? "· the thread's subject"
                : "· has a line break, so it can't be approved"}
            </span>
          </p>
        ) : (
          <Input
            id={`sales-subject-${id}`}
            size="sm"
            value={subject}
            disabled={!editable}
            onChange={(event) => card.editSubject(event.target.value)}
          />
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`sales-body-${id}`}>Body</Label>
        <Textarea
          id={`sales-body-${id}`}
          ref={bodyRef}
          value={body}
          disabled={!editable}
          onChange={(event) => card.editBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
        />
        {isDirty(state) ? (
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={card.cancelEdit}>
              Cancel
            </Button>
            <Button size="xs" disabled={state.busy !== null} onClick={() => void card.save()}>
              {state.busy === "edit" ? "Saving…" : "Save edit"}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
