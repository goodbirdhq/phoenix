import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import { intentLabel, sortConversations } from "@t3tools/client-runtime/sales/outreach";
import type {
  EnvironmentId,
  SalesConversation,
  SalesConversationDetail,
  SalesConversationList,
  SalesConversationMessage,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { salesEnvironment, useSalesDevice, useSalesState } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { useSalesListKeys } from "./useSalesListKeys";

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const formatAt = (iso: string | null) => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? "" : dateTime.format(ms);
};

const INTENT_VARIANT: Record<string, "success" | "warning" | "error" | "secondary" | "outline"> = {
  interested: "success",
  deferred: "warning",
  redirect: "warning",
  declined: "error",
  unsubscribe: "error",
};

/** Replies by contact, and each contact's history with our drafted answer. Read on demand. */
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listConversations({ environmentId, input: {} });
      if (result._tag === "Success") {
        setList(result.value);
        setFailure(null);
      } else {
        setFailure(readSalesFailure(result)?.description ?? "Could not read conversations.");
      }
    } finally {
      setLoading(false);
    }
  }, [environmentId, listConversations]);

  useEffect(() => {
    void load();
  }, [load]);

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
    edit: () => panel.current?.focusBody(),
  });

  if (list === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {failure ? "Conversations are unavailable" : "Reading conversations…"}
          </EmptyTitle>
          {failure ? <EmptyDescription>{failure}</EmptyDescription> : null}
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
        className="grid w-full gap-0.5 px-3 py-2 text-left"
        onClick={props.onSelect}
      >
        <span className="flex items-center gap-1.5">
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
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {item.latestReply?.preview ?? ""}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatAt(item.latestReply?.receivedAt ?? null)}
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
  const state = useSalesState(environmentId);
  const dispatches = Option.getOrNull(state.snapshot)?.dispatches ?? [];
  const [detail, setDetail] = useState<SalesConversationDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getConversation({
      environmentId,
      input: { contactKey: conversation.contactKey },
    });
    if (result._tag === "Success") setDetail(result.value);
    else setFailure(readSalesFailure(result)?.description ?? "Could not read this conversation.");
  }, [conversation.contactKey, environmentId, getConversation]);

  useEffect(() => {
    void load();
  }, [load]);

  const replyDraft =
    detail?.drafts.find((draft) => draft.kind === "reply") ??
    (conversation.replyDraft ? { ...conversation.replyDraft } : null);
  const contactThreads = dispatches.filter((entry) => entry.target === conversation.contactKey);

  const draftAnswer = async () => {
    setBusy(true);
    try {
      const result = await dispatch({
        environmentId,
        input: { action: "draft-reply", contactKey: conversation.contactKey, note },
      });
      // The started thread arrives in the snapshot's dispatches and is linked below.
      if (result._tag === "Success") {
        setDispatchError(null);
        setNote("");
      } else {
        setDispatchError(readSalesFailure(result)?.description ?? "Could not start the run.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 grid-cols-1 xl:grid-cols-2">
      <section
        aria-label="History"
        className="flex min-h-0 flex-col gap-3 overflow-y-auto border-b p-4 xl:border-r xl:border-b-0"
      >
        <h2 className="text-sm font-medium">
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
          failure ? (
            <p className="text-sm text-muted-foreground">{failure}</p>
          ) : (
            <Spinner />
          )
        ) : (
          <ol className="grid gap-3">
            {detail.messages.map((message) => (
              <MessageItem
                key={`${message.direction}:${message.id}:${message.at ?? ""}`}
                message={message}
              />
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Our answer" className="flex min-h-0 flex-col">
        {replyDraft ? (
          <SalesDraftPanel
            key={replyDraft.activityId}
            ref={ref}
            environmentId={environmentId}
            activityId={replyDraft.activityId}
            listedHash={replyDraft.contentHash}
            canAct={props.canAct}
            device={props.device}
            dispatches={dispatches}
            approveLabel="Approve answer"
            discardLabel="No reply needed"
            // The answer is gone and its run did not start: the Draft an answer form takes over
            // once the conversation is read again, and shows why.
            onAnswerDiscarded={setDispatchError}
            onChanged={() => {
              void props.onChanged();
              void load();
            }}
          />
        ) : (
          <div className="grid gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              {conversation.awaitingAnswer
                ? "No answer is drafted yet."
                : "Nothing waits on an answer here."}
            </p>
            {props.canAct && conversation.awaitingAnswer ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void draftAnswer();
                }}
              >
                <Label htmlFor={`sales-reply-note-${conversation.contactKey}`}>
                  Note for the drafter (optional)
                </Label>
                <Textarea
                  id={`sales-reply-note-${conversation.contactKey}`}
                  size="sm"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="flex justify-end">
                  <Button type="submit" size="xs" disabled={busy}>
                    {busy ? "Starting…" : "Draft an answer"}
                  </Button>
                </div>
                {dispatchError ? (
                  <p className="text-xs text-destructive-foreground">{dispatchError}</p>
                ) : null}
              </form>
            ) : null}
            {contactThreads.map((thread) => (
              <Link
                key={thread.threadId}
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.threadId }}
                className="text-xs underline"
              >
                {thread.title}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** A message from either side. Their words are text from a stranger: never markup. */
function MessageItem({ message }: { readonly message: SalesConversationMessage }) {
  const ours = message.direction === "out";
  return (
    <li className={ours ? "rounded-lg border p-3" : "rounded-lg border bg-accent/40 p-3"}>
      <p className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{ours ? "Us" : message.kind === "reply" ? "Them" : message.kind}</span>
        {message.mailbox ? <span>{message.mailbox}</span> : null}
        <span>{formatAt(message.at)}</span>
        {message.step !== null ? <span>Email {message.step}</span> : null}
        {message.status && message.status !== "sent" ? <span>{message.status}</span> : null}
        {message.bounced ? <span>bounced ({message.bounced})</span> : null}
        {message.classification ? <span>{intentLabel(message.classification.intent)}</span> : null}
      </p>
      {message.subject ? <p className="text-sm font-medium">{message.subject}</p> : null}
      <p className="text-sm whitespace-pre-wrap">{message.text}</p>
    </li>
  );
}
