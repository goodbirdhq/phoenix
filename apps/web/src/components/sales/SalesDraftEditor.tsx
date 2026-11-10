import { displayedDraft } from "@t3tools/client-runtime/sales/signing";
import {
  type DraftCard,
  type DraftCardState,
  isDirty,
  isEditing,
} from "@t3tools/client-runtime/sales/draft-card";
import {
  type DraftField,
  findingPlace,
  hiddenTextFindings,
} from "@t3tools/client-runtime/sales/hidden-text";
import type { SalesQueueItemDetail } from "@t3tools/contracts";
import { type KeyboardEvent, type ReactNode, type Ref, useMemo } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SalesMarkedText } from "./SalesMarkedText";

/**
 * A draft as the email it will be: To, From, subject and body, shown exactly as hashed
 * (`displayedDraft`), so what the person reads is what Approve signs. Text that would not show as
 * sent is marked in place (`hiddenTextFindings`), and Approve refuses it. An edit swaps in inputs.
 */
export function SalesDraftEditor(props: {
  readonly card: DraftCard;
  readonly state: DraftCardState;
  readonly detail: SalesQueueItemDetail;
  /** The body input while editing, so the page can return focus to it (E, palette). */
  readonly bodyRef?: Ref<HTMLTextAreaElement>;
}) {
  const { card, state, detail, bodyRef } = props;
  const shown = displayedDraft(detail);
  const editing = isEditing(state);
  const subject = state.subjectDraft ?? shown.subject;
  const body = state.bodyDraft ?? shown.body;
  const id = detail.activityId;
  const findings = useMemo(
    () => hiddenTextFindings({ to: shown.to, subject, body }),
    [shown.to, subject, body],
  );
  const inField = (field: DraftField) => findings.filter((finding) => finding.field === field);
  // A threaded draft keeps its thread's subject. A subject with hidden text is shown as text,
  // marked, until it is edited: a one-line field would hide it or drop its line breaks.
  const subjectAsText =
    !editing || detail.threaded || (state.subjectDraft === null && inField("subject").length > 0);
  const removable = findings.some(
    (finding) =>
      finding.kind === "character" &&
      (finding.field === "body" || (finding.field === "subject" && !detail.threaded)),
  );
  // Escape leaves an untouched edit; it never throws away typed text.
  const onEscape = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    if (isDirty(state)) event.currentTarget.blur();
    else card.cancelEdit();
  };

  return (
    <article aria-label="Email" className="grid gap-3 rounded-lg border p-4">
      <dl className="grid gap-1 text-xs">
        <HeaderLine label="To">
          <SalesMarkedText text={shown.to} findings={inField("to")} />
        </HeaderLine>
        <HeaderLine label="From">
          {detail.mailbox.sticky && detail.mailbox.address
            ? detail.mailbox.address
            : "Any active mailbox"}
        </HeaderLine>
      </dl>
      {subjectAsText ? (
        <h2 className="text-base font-medium break-words whitespace-pre-wrap">
          <SalesMarkedText text={subject} findings={inField("subject")} />
          {detail.threaded || inField("subject").length > 0 ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {inField("subject").length > 0
                ? "Has hidden text, so it can't be approved"
                : "The thread's subject"}
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
            onKeyDown={onEscape}
          />
        </div>
      )}
      {editing ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`sales-body-${id}`}>Body</Label>
          <Textarea
            id={`sales-body-${id}`}
            ref={bodyRef}
            // Opening an edit (E or the Edit button) lands in the body.
            autoFocus
            value={body}
            disabled={state.busy !== null}
            onChange={(event) => card.editBody(event.target.value)}
            onKeyDown={onEscape}
          />
          {findings.length > 0 ? (
            <p className="text-xs text-warning-foreground">
              Still hidden:{" "}
              {findings
                .slice(0, 5)
                .map((finding) => `${finding.token.trim()} in ${findingPlace(body, finding)}`)
                .join(", ")}
              {findings.length > 5 ? `, and ${findings.length - 5} more` : ""}.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {removable ? (
              <Button
                size="xs"
                variant="outline"
                disabled={state.busy !== null}
                onClick={card.removeHiddenCharacters}
              >
                Remove hidden characters
              </Button>
            ) : null}
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
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          <SalesMarkedText text={body} findings={inField("body")} />
        </p>
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
