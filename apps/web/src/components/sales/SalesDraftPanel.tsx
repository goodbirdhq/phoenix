import { type DraftNotice, isDirty } from "@t3tools/client-runtime/sales/draft-card";
import { kindLabel, stateLabel } from "@t3tools/client-runtime/sales/outreach";
import type { EnvironmentId, SalesDispatchSource, SalesQueueItemDetail } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { type Ref, useCallback, useImperativeHandle, useMemo, useRef } from "react";

import type { useSalesDevice } from "../../state/sales";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { SalesDraftAbout } from "./SalesDraftAbout";
import { SalesDraftActions } from "./SalesDraftActions";
import { SalesDraftEditor } from "./SalesDraftEditor";
import { SalesRuns } from "./SalesRuns";
import { useDraftCard } from "./useDraftCard";

export type SalesDeviceView = ReturnType<typeof useSalesDevice>;

/** What the page's keyboard shortcuts and command palette entries call. */
export interface SalesDraftPanelHandle {
  readonly approve: () => void;
  readonly edit: () => void;
}

const STATE_VARIANT: Record<string, "warning" | "success" | "secondary" | "error" | "outline"> = {
  awaiting: "warning",
  approved: "success",
  held: "secondary",
  refused: "error",
};

/**
 * One draft, read as the email it will be and edited in place, with every action on it. The card's logic, including the rule
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
  readonly approveLabel?: string;
  readonly discardLabel?: string;
  readonly allowResearch?: boolean;
  /** Where runs listed with the draft came from (memoized); the draft's own card when not given. */
  readonly runSources?: ReadonlyArray<SalesDispatchSource>;
  /** Shows who the draft is to and how it came about: beside the email when there is room. */
  readonly showAbout?: boolean;
  /** Called after any action, so a page can read its own list again. */
  readonly onChanged?: () => void;
  /** Called when a plan discarded the draft but the run that replaces it did not start. */
  readonly onDiscardedWithoutRun?: (message: string) => void;
  readonly ref?: Ref<SalesDraftPanelHandle>;
}) {
  const { environmentId, activityId } = props;
  const [card, state] = useDraftCard(props);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    approve: () => void card.approve(props.device),
    edit: () => {
      if (!props.canAct) return;
      card.startEdit();
      // An edit already open (say, left with Escape) gets its body back; a new one autofocuses.
      bodyRef.current?.focus();
    },
  }));
  // A run started here may have written a new version: read it once, unless mid-edit, and let
  // the page read its own list.
  const { onChanged } = props;
  const onRunSettled = useCallback(() => {
    if (!isDirty(card.getState())) void card.load();
    onChanged?.();
  }, [card, onChanged]);
  const runSources = useMemo(
    () => props.runSources ?? [{ activityId }],
    [props.runSources, activityId],
  );

  const detail = state.detail;
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {state.loadFailure ?? <Spinner />}
      </div>
    );
  }
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The email keeps a readable measure; About sits beside it only when there is room. */}
      <div
        className={
          props.showAbout
            ? "grid gap-6 p-4 @3xl:grid-cols-[minmax(0,70ch)_15rem] @3xl:p-6"
            : "grid p-4 @3xl:p-6"
        }
      >
        <div className="grid max-w-[70ch] min-w-0 content-start gap-4">
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
          <SalesDraftEditor card={card} state={state} detail={detail} bodyRef={bodyRef} />
          <dl className="grid gap-1 text-xs empty:hidden">
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
          />
          <SalesRuns environmentId={environmentId} sources={runSources} onSettled={onRunSettled} />
        </div>
        {props.showAbout ? <SalesDraftAbout detail={detail} /> : null}
      </div>
    </div>
  );
}

function DraftHeading({ detail }: { readonly detail: SalesQueueItemDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-xs text-muted-foreground">
        {kindLabel(detail.kind)}
        {detail.stepLabel ? ` · ${detail.stepLabel}` : ""}
      </p>
      <Badge size="sm" variant={STATE_VARIANT[detail.state] ?? "outline"}>
        {stateLabel(detail.state)}
      </Badge>
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
