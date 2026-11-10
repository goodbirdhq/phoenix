import { displayedDraft } from "@t3tools/client-runtime/sales/signing";
import type { DraftNotice } from "@t3tools/client-runtime/sales/draft-card";
import { kindLabel, stateLabel } from "@t3tools/client-runtime/sales/outreach";
import type { EnvironmentId, SalesDispatch, SalesQueueItemDetail } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { type Ref, useImperativeHandle, useRef } from "react";

import type { useSalesDevice } from "../../state/sales";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { SalesDraftActions } from "./SalesDraftActions";
import { SalesDraftEditor } from "./SalesDraftEditor";
import { useDraftCard } from "./useDraftCard";

export type SalesDeviceView = ReturnType<typeof useSalesDevice>;

/** What the page's keyboard shortcuts and command palette entries call. */
export interface SalesDraftPanelHandle {
  readonly approve: () => void;
  readonly focusBody: () => void;
}

const STATE_VARIANT: Record<string, "warning" | "success" | "secondary" | "error" | "outline"> = {
  awaiting: "warning",
  approved: "success",
  held: "secondary",
  refused: "error",
};

/**
 * One draft, editable in place, with every action on it. The card's logic, including the rule
 * that Approve signs only a version just hashed from the text shown, is `createDraftCard`'s;
 * this renders it.
 */
export function SalesDraftPanel({
  ref,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly activityId: string;
  /** The hash the list shows for this card; a change means the engine has a new version. */
  readonly listedHash: string | null;
  readonly canAct: boolean;
  readonly device: SalesDeviceView;
  readonly dispatches: ReadonlyArray<SalesDispatch>;
  readonly approveLabel?: string;
  readonly discardLabel?: string;
  readonly allowResearch?: boolean;
  /** Called after any action, so a page can read its own list again. */
  readonly onChanged?: () => void;
  /** Called when a reply redraft discarded the answer but its run did not start. */
  readonly onAnswerDiscarded?: (message: string) => void;
  readonly ref?: Ref<SalesDraftPanelHandle>;
}) {
  const { environmentId, activityId } = props;
  const [card, state] = useDraftCard(props);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const focusBody = () => bodyRef.current?.focus();
  useImperativeHandle(ref, () => ({ approve: () => void card.approve(props.device), focusBody }));

  const detail = state.detail;
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {state.loadFailure ?? <Spinner />}
      </div>
    );
  }
  const threads = props.dispatches.filter((entry) => entry.target === activityId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <DraftHeading detail={detail} />
      {state.notice ? (
        <DraftNoticeAlert environmentId={environmentId} notice={state.notice} />
      ) : null}
      {state.lostText !== null ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Your unsaved text</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border p-2 font-sans">
            {state.lostText}
          </pre>
        </details>
      ) : null}
      <SalesDraftEditor
        card={card}
        state={state}
        detail={detail}
        canAct={props.canAct}
        bodyRef={bodyRef}
      />
      <dl className="grid gap-1 text-xs">
        {detail.goes ? <StatusLine label="Goes">{detail.goes}</StatusLine> : null}
        {detail.refusal ? <StatusLine label="Refused">{detail.refusal}</StatusLine> : null}
        {detail.note ? <StatusLine label="Note">{detail.note}</StatusLine> : null}
        {detail.skip ? <StatusLine label="Not sent">{detail.skip.reason}</StatusLine> : null}
        {detail.check ? <StatusLine label="Check first">{detail.check}</StatusLine> : null}
      </dl>
      <SalesDraftActions
        card={card}
        state={state}
        detail={detail}
        canAct={props.canAct}
        device={props.device}
        approveLabel={props.approveLabel}
        discardLabel={props.discardLabel}
        allowResearch={props.allowResearch ?? false}
        onEdit={focusBody}
      />
      {threads.length > 0 ? (
        <section aria-label="Runs started here" className="grid gap-1 text-xs">
          <h3 className="text-muted-foreground">Runs started from this draft</h3>
          {threads.map((thread) => (
            <Link
              key={thread.threadId}
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: thread.threadId }}
              className="underline"
            >
              {thread.title}
            </Link>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function DraftHeading({ detail }: { readonly detail: SalesQueueItemDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-medium">
        {kindLabel(detail.kind)}
        {detail.stepLabel ? ` · ${detail.stepLabel}` : ""}
      </h2>
      <Badge variant={STATE_VARIANT[detail.state] ?? "outline"}>{stateLabel(detail.state)}</Badge>
      <span className="min-w-0 flex-1 text-right text-xs break-all whitespace-pre-wrap text-muted-foreground">
        To {displayedDraft(detail).to}
        {detail.mailbox.address ? ` from ${detail.mailbox.address}` : ""}
      </span>
    </div>
  );
}

function DraftNoticeAlert(props: {
  readonly environmentId: EnvironmentId;
  readonly notice: DraftNotice;
}) {
  const { notice } = props;
  return (
    <Alert variant={notice.tone}>
      <AlertTitle>{notice.title}</AlertTitle>
      {notice.description || notice.thread ? (
        <AlertDescription>
          {notice.description}
          {notice.thread ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: props.environmentId, threadId: notice.thread.threadId }}
              className="underline"
            >
              Open “{notice.thread.title}”
            </Link>
          ) : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

function StatusLine({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap">{children}</dd>
    </div>
  );
}
