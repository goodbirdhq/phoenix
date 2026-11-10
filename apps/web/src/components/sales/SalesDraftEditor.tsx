import { displayedDraft } from "@t3tools/client-runtime/sales/signing";
import {
  type DraftCard,
  type DraftCardState,
  isDirty,
  isEditing,
} from "@t3tools/client-runtime/sales/draft-card";
import type { SalesQueueItemDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * A draft as the email it will be: To, From, subject and body, shown exactly as hashed
 * (`displayedDraft`), so what the person reads is what Approve signs. An edit swaps in inputs.
 */
export function SalesDraftEditor(props: {
  readonly card: DraftCard;
  readonly state: DraftCardState;
  readonly detail: SalesQueueItemDetail;
}) {
  const { card, state, detail } = props;
  const shown = displayedDraft(detail);
  const editing = isEditing(state);
  const subject = state.subjectDraft ?? shown.subject;
  const body = state.bodyDraft ?? shown.body;
  const id = detail.activityId;
  // A threaded draft keeps its thread's subject; a subject with a line break is shown as text,
  // since a one-line field would hide part of what is hashed.
  const subjectAsText =
    !editing || detail.threaded || (state.subjectDraft === null && /[\r\n]/u.test(subject));

  return (
    <article aria-label="Email" className="grid gap-3 rounded-lg border p-4">
      <dl className="grid gap-1 text-xs">
        <HeaderLine label="To">{shown.to}</HeaderLine>
        <HeaderLine label="From">
          {detail.mailbox.sticky && detail.mailbox.address
            ? detail.mailbox.address
            : "Any active mailbox"}
        </HeaderLine>
      </dl>
      {subjectAsText ? (
        <h2 className="text-base font-medium break-words whitespace-pre-wrap">
          {subject}
          {detail.threaded || /[\r\n]/u.test(subject) ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {detail.threaded
                ? "The thread's subject"
                : "Has a line break, so it can't be approved"}
            </span>
          ) : null}
        </h2>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={`sales-subject-${id}`}>Subject</Label>
          <Input
            id={`sales-subject-${id}`}
            size="sm"
            value={subject}
            disabled={state.busy !== null}
            onChange={(event) => card.editSubject(event.target.value)}
          />
        </div>
      )}
      {editing ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`sales-body-${id}`}>Body</Label>
          <Textarea
            id={`sales-body-${id}`}
            // Opening an edit (E or the Edit button) lands in the body.
            autoFocus
            value={body}
            disabled={state.busy !== null}
            onChange={(event) => card.editBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape leaves an untouched edit; it never throws away typed text.
              if (isDirty(state)) event.currentTarget.blur();
              else card.cancelEdit();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={card.cancelEdit}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={state.busy !== null || !isDirty(state)}
              onClick={() => void card.save()}
            >
              {state.busy === "edit" ? "Saving…" : "Save edit"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>
      )}
    </article>
  );
}

function HeaderLine({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}
