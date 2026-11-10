import { emailStepLabel } from "@t3tools/client-runtime/sales/campaigns";
import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import { intentLabel, sortConversations } from "@t3tools/client-runtime/sales/outreach";
import { salesDateTime } from "@t3tools/client-runtime/sales/time";
import {
  type EnvironmentId,
  type SalesConversation,
  type SalesConversationDetail,
  type SalesConversationList,
  type SalesConversationMessage,
  safeSalesNote,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentConnected } from "../../state/environments";
import { salesEnvironment, useSalesDevice } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  SalesDraftPanel,
  type SalesDraftPanelHandle,
  type SalesDeviceView,
} from "./SalesDraftPanel";
import { SalesRuns } from "./SalesRuns";
import { useSalesListKeys } from "./useSalesListKeys";

const INTENT_VARIANT: Record<string, "success" | "warning" | "error" | "secondary" | "outline"> = {
  interested: "success",
  deferred: "warning",
  redirect: "warning",
  declined: "error",
  unsubscribe: "error",
};

/**
 * Replies by contact, and each contact's history with our drafted answer. Read once the
 * environment is connected, and again on reconnect.
 */
export function SalesConversations(props: {
  readonly environmentId: EnvironmentId;
  readonly baseUrl: string;
  readonly canAct: boolean;
  readonly selected: string | undefined;
  readonly onSelect: (contactKey: string) => void;
}) {
  const { environmentId, canAct } = props;
  const listConversations = useAtomCommand(salesEnvironment.listConversations, {
    reportFailure: false,
  });
  const [list, setList] = useState<SalesConversationList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const device = useSalesDevice(environmentId, props.baseUrl, canAct);
  const panel = useRef<SalesDraftPanelHandle>(null);
  const connected = useEnvironmentConnected(environmentId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listConversations({ environmentId, input: {} });
      if (result._tag === "Success") {
        setList(result.value);
        setFailure(null);
      } else {
        setFailure(readSalesFailure(result).description);
      }
    } finally {
      setLoading(false);
    }
  }, [environmentId, listConversations]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const items = useMemo(() => sortConversations(list?.items ?? []), [list]);
  const current = items.find((item) => item.contactKey === props.selected) ?? items[0] ?? null;
  const move = (delta: number) => {
    const index = current === null ? -1 : items.indexOf(current);
    const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
    if (next) props.onSelect(next.contactKey);
  };
  useSalesListKeys({
    next: () => move(1),
    previous: () => move(-1),
    approve: () => panel.current?.approve(),
    edit: () => panel.current?.edit(),
  });

  if (list === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {failure && connected ? "Conversations are unavailable" : "Reading conversations…"}
          </EmptyTitle>
          {failure && connected ? <EmptyDescription>{failure}</EmptyDescription> : null}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
      <aside
        aria-label="Conversations"
        className="flex min-h-0 flex-col border-b md:border-r md:border-b-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1 text-xs text-muted-foreground">
            {items.filter((item) => item.awaitingAnswer).length} waiting on an answer
            {failure ? " · stale" : ""}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh conversations"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCwIcon />
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <li className="p-4 text-sm text-muted-foreground">No replies yet.</li>
          ) : null}
          {items.map((item) => (
            <ConversationRow
              key={item.contactKey}
              item={item}
              selected={item.contactKey === current?.contactKey}
              onSelect={() => props.onSelect(item.contactKey)}
            />
          ))}
        </ul>
      </aside>
      {current ? (
        <ConversationDetailView
          key={current.contactKey}
          ref={panel}
          environmentId={environmentId}
          conversation={current}
          canAct={canAct}
          device={device}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

function ConversationRow(props: {
  readonly item: SalesConversation;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { item } = props;
  const intent = item.latestReply?.classification?.intent ?? null;
  return (
    <li aria-selected={props.selected} className="aria-selected:bg-accent">
      <button
        type="button"
        // One shrinkable column, so long names and previews truncate instead of widening the row.
        className="grid w-full grid-cols-[minmax(0,1fr)] gap-0.5 px-3 py-2 text-left"
        onClick={props.onSelect}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">
            {item.contact.name ?? item.contact.email ?? "Unknown contact"}
            {item.contact.accountName ? (
              <span className="text-muted-foreground"> · {item.contact.accountName}</span>
            ) : null}
          </span>
          <Badge size="sm" variant={INTENT_VARIANT[intent ?? ""] ?? "outline"}>
            {intentLabel(intent)}
          </Badge>
        </span>
        <span className="line-clamp-2 text-xs break-words text-muted-foreground">
          {item.latestReply?.preview ?? ""}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {salesDateTime(item.latestReply?.receivedAt ?? null)}
          {item.hasOpenDraft
            ? " · answer drafted"
            : item.awaitingAnswer
              ? " · needs an answer"
              : ""}
        </span>
      </button>
    </li>
  );
}

function ConversationDetailView({
  ref,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: SalesConversation;
  readonly canAct: boolean;
  readonly device: SalesDeviceView;
  readonly onChanged: () => Promise<void>;
  readonly ref: React.Ref<SalesDraftPanelHandle>;
}) {
  const { environmentId, conversation } = props;
  const getConversation = useAtomCommand(salesEnvironment.getConversation, {
    reportFailure: false,
  });
  const dispatch = useAtomCommand(salesEnvironment.dispatch, { reportFailure: false });
  const [detail, setDetail] = useState<SalesConversationDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const connected = useEnvironmentConnected(environmentId);

  const load = useCallback(async () => {
    const result = await getConversation({
      environmentId,
      input: { contactKey: conversation.contactKey },
    });
    if (result._tag === "Success") setDetail(result.value);
    else setFailure(readSalesFailure(result).description);
  }, [conversation.contactKey, environmentId, getConversation]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const { onChanged } = props;
  // A run that drafted an answer settles: read the conversation and the list once more.
  const reread = useCallback(() => {
    void onChanged();
    void load();
  }, [load, onChanged]);

  const replyDraft =
    detail?.drafts.find((draft) => draft.kind === "reply") ??
    (conversation.replyDraft ? { ...conversation.replyDraft } : null);
  const answer = detail?.dispatch.answer ?? null;
  const contactRuns = useMemo(
    () => [{ contactKey: conversation.contactKey }],
    [conversation.contactKey],
  );
  const replyDraftId = replyDraft?.activityId ?? null;
  const draftRuns = useMemo(
    () => (replyDraftId === null ? contactRuns : [{ activityId: replyDraftId }, ...contactRuns]),
    [contactRuns, replyDraftId],
  );
  // Stacked, the answer follows their latest message: what came before it folds away.
  const messages = detail?.messages ?? [];
  const latestInbound = messages.findLastIndex((message) => message.direction === "in");
  const earlier = showEarlier ? 0 : Math.max(0, latestInbound);

  const draftAnswer = async () => {
    if (answer === null) return;
    setBusy(true);
    try {
      const result = await dispatch({
        environmentId,
        input: {
          contactKey: conversation.contactKey,
          action: "answer",
          expectedHash: answer.card?.expectedHash ?? null,
          note,
        },
      });
      // The started thread joins the read model and is linked below.
      if (result._tag === "Success") {
        setDispatchError(null);
        setNote("");
      } else {
        const failure = readSalesFailure(result);
        setDispatchError(failure.description);
        if (failure.reread) await load();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    // One scroll, history then answer, until there is room for both side by side.
    <div className="@container min-h-0 overflow-y-auto">
      <div className="grid @5xl:h-full @5xl:grid-cols-2">
        <section
          aria-label="History"
          className="flex flex-col gap-3 border-b p-4 @5xl:min-h-0 @5xl:overflow-y-auto @5xl:border-r @5xl:border-b-0"
        >
          <h2 className="text-sm font-medium break-words">
            {conversation.contact.name ?? conversation.contact.email ?? "Conversation"}
            {conversation.mailboxes.length > 0 ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {conversation.mailboxes.join(", ")}
              </span>
            ) : null}
          </h2>
          {conversation.latestReply?.classification?.summary ? (
            <p className="text-xs text-muted-foreground">
              {conversation.latestReply.classification.summary}
            </p>
          ) : null}
          {detail === null ? (
            failure && connected ? (
              <p className="text-sm text-muted-foreground">{failure}</p>
            ) : (
              <Spinner />
            )
          ) : (
            <>
              {earlier > 0 ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="self-start @5xl:hidden"
                  onClick={() => setShowEarlier(true)}
                >
                  {earlier === 1 ? "Show 1 earlier message" : `Show ${earlier} earlier messages`}
                </Button>
              ) : null}
              <ol className="grid max-w-[70ch] gap-3">
                {messages.map((message, index) => (
                  <MessageItem
                    key={`${message.direction}:${message.id}:${message.at ?? ""}`}
                    message={message}
                    folded={index < earlier}
                  />
                ))}
              </ol>
            </>
          )}
        </section>
        <section aria-label="Our answer" className="flex flex-col @5xl:min-h-0">
          {replyDraft ? (
            <SalesDraftPanel
              key={replyDraft.activityId}
              ref={ref}
              environmentId={environmentId}
              activityId={replyDraft.activityId}
              listedHash={replyDraft.contentHash}
              canAct={props.canAct}
              device={props.device}
              approveLabel="Approve answer"
              discardLabel="No reply needed"
              runSources={draftRuns}
              // The draft is gone and its run did not start: the conversation's own plans take
              // over once it is read again, and this shows why.
              onDiscardedWithoutRun={setDispatchError}
              onChanged={reread}
            />
          ) : (
            <div className="grid max-w-[70ch] content-start gap-4 p-4 @3xl:p-6">
              <p className="text-sm text-muted-foreground">
                {conversation.awaitingAnswer
                  ? "No answer is drafted yet."
                  : "Nothing waits on an answer here."}
              </p>
              {props.canAct && answer ? (
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void draftAnswer();
                  }}
                >
                  <Label htmlFor={`sales-reply-note-${conversation.contactKey}`}>
                    {answer.noteRequired
                      ? "Note for the drafter"
                      : "Note for the drafter (optional)"}
                  </Label>
                  <Textarea
                    id={`sales-reply-note-${conversation.contactKey}`}
                    size="sm"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      size="xs"
                      disabled={busy || (answer.noteRequired && safeSalesNote(note).length === 0)}
                    >
                      {busy ? "Starting…" : answer.title}
                    </Button>
                  </div>
                  {dispatchError ? (
                    <p className="text-xs text-destructive-foreground">{dispatchError}</p>
                  ) : null}
                </form>
              ) : null}
              <SalesRuns environmentId={environmentId} sources={contactRuns} onSettled={reread} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * A message from either side. Their words are text from a stranger: never markup. A folded
 * message shows only beside the answer, not stacked above it.
 */
function MessageItem({
  message,
  folded,
}: {
  readonly message: SalesConversationMessage;
  readonly folded: boolean;
}) {
  const ours = message.direction === "out";
  return (
    <li
      className={cn(
        "rounded-lg border p-3",
        !ours && "bg-accent/40",
        folded && "hidden @5xl:block",
      )}
    >
      <p className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{ours ? "Us" : message.kind === "reply" ? "Them" : message.kind}</span>
        {message.mailbox ? <span>{message.mailbox}</span> : null}
        <span>{salesDateTime(message.at)}</span>
        {message.step !== null ? <span>{emailStepLabel(message.step)}</span> : null}
        {message.status && message.status !== "sent" ? <span>{message.status}</span> : null}
        {message.bounced ? <span>bounced ({message.bounced})</span> : null}
        {message.classification ? <span>{intentLabel(message.classification.intent)}</span> : null}
      </p>
      {message.subject ? <p className="text-sm font-medium">{message.subject}</p> : null}
      <p className="text-sm whitespace-pre-wrap">{message.text}</p>
    </li>
  );
}
