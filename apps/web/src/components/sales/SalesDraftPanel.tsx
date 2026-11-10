import { readSalesFailure } from "@t3tools/client-runtime/sales/failure";
import { displayedDraft, verifyDisplayedVersion } from "@t3tools/client-runtime/sales/approval";
import { thisDeviceDescription } from "@t3tools/client-runtime/sales/devices";
import {
  cardActions,
  kindLabel,
  listedVersionMoved,
  stateLabel,
} from "@t3tools/client-runtime/sales/outreach";
import type {
  EnvironmentId,
  SalesDispatch,
  SalesDispatchInput,
  SalesQueueItemDetail,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { salesEnvironment, type useSalesDevice } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { useApproveVersions } from "./salesApproval";

export type SalesDeviceView = ReturnType<typeof useSalesDevice>;

/** What the page's keyboard shortcuts and command palette entries call. */
export interface SalesDraftPanelHandle {
  readonly approve: () => void;
  readonly focusBody: () => void;
}

interface Notice {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
  readonly thread?: SalesDispatch;
}

const STATE_VARIANT: Record<string, "warning" | "success" | "secondary" | "error" | "outline"> = {
  awaiting: "warning",
  approved: "success",
  held: "secondary",
  refused: "error",
};

/**
 * One draft, editable in place, with every action on it. What it shows comes from the card's
 * hash inputs, and Approve signs only after hashing exactly that text again here; a draft that
 * moved on is read again and shown, never signed for the person.
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
  const { environmentId, activityId, device, canAct } = props;
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  const unapprove = useAtomCommand(salesEnvironment.unapprove, { reportFailure: false });
  const edit = useAtomCommand(salesEnvironment.edit, { reportFailure: false });
  const discard = useAtomCommand(salesEnvironment.discard, { reportFailure: false });
  const dispatch = useAtomCommand(salesEnvironment.dispatch, { reportFailure: false });
  const approveVersions = useApproveVersions(environmentId);

  const [detail, setDetail] = useState<SalesQueueItemDetail | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [subjectDraft, setSubjectDraft] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lostText, setLostText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [redraftNote, setRedraftNote] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirty = subjectDraft !== null || bodyDraft !== null;

  const load = useCallback(async () => {
    const result = await getQueueItem({ environmentId, input: { activityId } });
    if (result._tag === "Success") {
      setDetail(result.value);
      setLoadFailure(null);
      setSubjectDraft(null);
      setBodyDraft(null);
    } else {
      setLoadFailure(readSalesFailure(result)?.description ?? "Could not read this draft.");
    }
  }, [activityId, environmentId, getQueueItem]);

  // Pages key this panel by card, so a new card is a fresh mount.
  useEffect(() => {
    void load();
  }, [load]);

  // The engine has a new version of this card. Show it, unless the person is mid-edit. Only a
  // change in the listed hash reads again, so a read that disagrees with the list cannot loop.
  const listedHash = props.listedHash;
  const previousListedHash = useRef(listedHash);
  useEffect(() => {
    const previous = previousListedHash.current;
    previousListedHash.current = listedHash;
    if (!listedVersionMoved(previous, listedHash, detail?.contentHash ?? null)) return;
    if (dirty) {
      setNotice({
        tone: "warning",
        title: "This draft changed in the engine",
        description: "Saving now will be refused. Cancel your edit to see the new version.",
      });
    } else {
      void load();
    }
  }, [detail, dirty, listedHash, load]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } finally {
      setBusy(null);
      props.onChanged?.();
    }
  };

  const approve = () => {
    if (detail === null || busy !== null) return;
    if (dirty) {
      setNotice({ tone: "warning", title: "Save or cancel your edit before approving." });
      return;
    }
    if (device.blocked !== null) {
      setNotice({
        tone: "warning",
        title: "This client cannot approve",
        description: device.blocked,
      });
      return;
    }
    if (device.key === null || device.state !== "active") {
      setNotice({
        tone: "warning",
        title: "This device cannot approve",
        description: thisDeviceDescription(device.state, device.key),
      });
      return;
    }
    const key = device.key;
    void run("approve", async () => {
      const verified = await verifyDisplayedVersion(detail);
      if (!verified.ok) {
        setNotice({
          tone: "error",
          title: "Phoenix will not sign this",
          description:
            verified.reason === "algorithm"
              ? "The engine hashes drafts in a way this version of Phoenix does not know. Update Phoenix."
              : verified.reason === "subject-lines"
                ? "The subject has a line break. Edit it onto one line, then approve."
                : "The text shown is not the version the engine reports. It has been read again; look before approving.",
        });
        await load();
        return;
      }
      const [outcome] = await approveVersions(key, [
        { activityId, contentHash: verified.contentHash },
      ]);
      if (outcome === undefined) return;
      setNotice({
        tone: outcome.ok ? "success" : outcome.stale || outcome.unknown ? "warning" : "error",
        title: outcome.ok ? "Approved" : outcome.unknown ? "Outcome unknown" : "Not approved",
        description: outcome.text,
      });
      await load();
    });
  };

  useImperativeHandle(ref, () => ({ approve, focusBody: () => bodyRef.current?.focus() }));

  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {loadFailure ?? <Spinner />}
      </div>
    );
  }

  const shown = displayedDraft(detail);
  const subject = subjectDraft ?? shown.subject;
  const body = bodyDraft ?? shown.body;
  const actions = cardActions(detail);
  const isReply = detail.kind === "reply";
  const threads = props.dispatches.filter((entry) => entry.target === activityId);

  const save = () =>
    run("edit", async () => {
      const result = await edit({
        environmentId,
        input: {
          activityId,
          expectedHash: detail.contentHash,
          body,
          ...(detail.threaded || subjectDraft === null ? {} : { subject }),
        },
      });
      if (result._tag === "Success") {
        setNotice({
          tone: "success",
          title: "Saved",
          description: result.value.approvalLapsed
            ? "It was approved; that approval lapsed with the edit."
            : "It needs an approval before it goes.",
        });
        setLostText(null);
        await load();
        return;
      }
      const failure = readSalesFailure(result);
      if (failure === null) return;
      setNotice({ tone: "error", title: failure.title, description: failure.description });
      if (failure.reread) {
        setLostText(body);
        await load();
      }
    });

  const startDispatch = (input: SalesDispatchInput, after?: () => Promise<void>) =>
    run("dispatch", async () => {
      const result = await dispatch({ environmentId, input });
      if (result._tag === "Success") {
        setRedraftNote(null);
        setNotice({ tone: "success", title: "Run started", thread: result.value });
        await after?.();
        return;
      }
      const failure = readSalesFailure(result);
      if (failure === null) return;
      setNotice({ tone: "error", title: failure.title, description: failure.description });
      if (failure.state === "discarded") props.onAnswerDiscarded?.(failure.description);
      if (failure.reread) await load();
    });

  const discardDraft = () =>
    run("discard", async () => {
      const confirmation = requestConfirmDialog(
        `${props.discardLabel ?? "Discard this draft"}?\nIt is never sent. The Notion row becomes a note.`,
        { variant: "destructive" },
      );
      // No dialog to ask in means no confirmation, so nothing is discarded.
      if (confirmation === undefined) {
        setNotice({
          tone: "error",
          title: "Could not ask to confirm",
          description: "Nothing was discarded.",
        });
        return;
      }
      if (!(await confirmation)) return;
      const result = await discard({
        environmentId,
        input: { activityId, expectedHash: detail.contentHash },
      });
      const failure = readSalesFailure(result);
      setNotice(
        failure === null
          ? { tone: "success", title: "Discarded", description: "It will not be sent." }
          : { tone: "error", title: failure.title, description: failure.description },
      );
      await load();
    });

  const editable = canAct && actions.edit && busy === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">
          {kindLabel(detail.kind)}
          {detail.stepLabel ? ` · ${detail.stepLabel}` : ""}
        </h2>
        <Badge variant={STATE_VARIANT[detail.state] ?? "outline"}>{stateLabel(detail.state)}</Badge>
        <span className="min-w-0 flex-1 text-right text-xs break-all whitespace-pre-wrap text-muted-foreground">
          To {shown.to}
          {detail.mailbox.address ? ` from ${detail.mailbox.address}` : ""}
        </span>
      </div>

      {notice ? (
        <Alert variant={notice.tone}>
          <AlertTitle>{notice.title}</AlertTitle>
          {notice.description || notice.thread ? (
            <AlertDescription>
              {notice.description}
              {notice.thread ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: notice.thread.threadId }}
                  className="underline"
                >
                  Open “{notice.thread.title}”
                </Link>
              ) : null}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      {lostText !== null ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Your unsaved text</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border p-2 font-sans">{lostText}</pre>
        </details>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`sales-subject-${activityId}`}>Subject</Label>
        {detail.threaded || (subjectDraft === null && /[\r\n]/u.test(subject)) ? (
          // Shown as text, line breaks and all: a one-line field would hide what is hashed.
          <p id={`sales-subject-${activityId}`} className="text-sm whitespace-pre-wrap">
            {subject}{" "}
            <span className="text-xs text-muted-foreground">
              {detail.threaded
                ? "· the thread's subject"
                : "· has a line break, so it can't be approved"}
            </span>
          </p>
        ) : (
          <Input
            id={`sales-subject-${activityId}`}
            size="sm"
            value={subject}
            disabled={!editable}
            onChange={(event) => setSubjectDraft(event.target.value)}
          />
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`sales-body-${activityId}`}>Body</Label>
        <Textarea
          id={`sales-body-${activityId}`}
          ref={bodyRef}
          value={body}
          disabled={!editable}
          onChange={(event) => setBodyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
        />
        {dirty ? (
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setSubjectDraft(null);
                setBodyDraft(null);
                setNotice(null);
                // The engine moved on during the edit: show its version now.
                if (listedHash !== null && listedHash !== detail.contentHash) void load();
              }}
            >
              Cancel
            </Button>
            <Button size="xs" disabled={busy !== null} onClick={() => void save()}>
              {busy === "edit" ? "Saving…" : "Save edit"}
            </Button>
          </div>
        ) : null}
      </div>

      <dl className="grid gap-1 text-xs">
        {detail.goes ? <StatusLine label="Goes">{detail.goes}</StatusLine> : null}
        {detail.refusal ? <StatusLine label="Refused">{detail.refusal}</StatusLine> : null}
        {detail.note ? <StatusLine label="Note">{detail.note}</StatusLine> : null}
        {detail.skip ? <StatusLine label="Not sent">{detail.skip.reason}</StatusLine> : null}
        {detail.check ? <StatusLine label="Check first">{detail.check}</StatusLine> : null}
      </dl>

      {canAct ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            {actions.approve ? (
              <Button
                size="sm"
                disabled={
                  busy !== null || dirty || device.state !== "active" || device.blocked !== null
                }
                onClick={approve}
              >
                {busy === "approve" ? "Signing…" : (props.approveLabel ?? "Approve")}
              </Button>
            ) : null}
            {actions.unapprove ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run("unapprove", async () => {
                    const failure = readSalesFailure(
                      await unapprove({ environmentId, input: { activityId } }),
                    );
                    setNotice(
                      failure === null
                        ? { tone: "success", title: "Approval withdrawn" }
                        : { tone: "error", title: failure.title, description: failure.description },
                    );
                    await load();
                  })
                }
              >
                Unapprove
              </Button>
            ) : null}
            {actions.edit ? (
              <Button size="sm" variant="outline" onClick={() => bodyRef.current?.focus()}>
                Edit
              </Button>
            ) : null}
            {actions.redraft ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => setRedraftNote(redraftNote === null ? "" : null)}
              >
                Redraft with notes
              </Button>
            ) : null}
            {props.allowResearch && detail.contact.accountName ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void startDispatch({ action: "research", activityId })}
              >
                Research this
              </Button>
            ) : null}
            {actions.discard ? (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={busy !== null}
                onClick={() => void discardDraft()}
              >
                {props.discardLabel ?? "Discard"}
              </Button>
            ) : null}
          </div>
          {actions.approve ? (
            <p className="text-xs text-muted-foreground">
              {device.blocked ?? thisDeviceDescription(device.state, device.key)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Add the engine's action token in Settings › Integrations to act on drafts.
        </p>
      )}

      {redraftNote !== null ? (
        <form
          className="grid gap-2 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            // A reply redraft discards this card first, so read it again after.
            void startDispatch(
              {
                action: "redraft",
                activityId,
                expectedHash: detail.contentHash,
                note: redraftNote,
              },
              load,
            );
          }}
        >
          <Label htmlFor={`sales-redraft-${activityId}`}>What should the new draft do?</Label>
          <Textarea
            id={`sales-redraft-${activityId}`}
            size="sm"
            value={redraftNote}
            onChange={(event) => setRedraftNote(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {isReply
              ? "This discards the waiting answer, then starts a run that drafts a new one with your note."
              : "This starts a run in the sales agents project that rewrites this draft with your note."}
          </p>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={() => setRedraftNote(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="xs"
              disabled={busy !== null || redraftNote.trim().length === 0}
            >
              {busy === "dispatch" ? "Starting…" : "Start redraft"}
            </Button>
          </div>
        </form>
      ) : null}

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

function StatusLine({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap">{children}</dd>
    </div>
  );
}
