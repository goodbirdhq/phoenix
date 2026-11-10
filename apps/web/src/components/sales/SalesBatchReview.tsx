import { displayedDraft } from "@t3tools/client-runtime/sales/signing";
import {
  type ApproveOutcome,
  type ReviewedDraft,
  reviewTickedDraft,
} from "@t3tools/client-runtime/sales/approve";
import { thisDeviceDescription } from "@t3tools/client-runtime/sales/devices";
import { kindLabel } from "@t3tools/client-runtime/sales/outreach";
import type { EnvironmentId, SalesQueueItem, SalesQueueItemDetail } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { salesEnvironment, useApproveVersions } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import type { SalesDeviceView } from "./SalesDraftPanel";

/** A ticked row and the hash it had when the person ticked it. */
export interface TickedDraft {
  readonly row: SalesQueueItem;
  readonly tickedHash: string;
}

/**
 * The review step of a batch approval. Each ticked draft is read again and shown in full, exactly
 * as hashed: recipient, subject and body. A draft is signed only when the hash this client
 * recomputes from that shown text equals the engine's hash and the hash captured at the tick;
 * any other is shown as changed, unticked (`onUntick`) and never signed. One press signs the rest.
 */
export function SalesBatchReview(props: {
  readonly environmentId: EnvironmentId;
  readonly drafts: ReadonlyArray<TickedDraft>;
  readonly device: SalesDeviceView;
  readonly onUntick: (activityId: string) => void;
  readonly onDone: (outcomes: ReadonlyArray<ApproveOutcome>) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, drafts, device, onUntick } = props;
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  const approveVersions = useApproveVersions(environmentId);
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, ReviewedDraft>>(new Map());
  const [signing, setSigning] = useState(false);

  // Read when the step opens (the page holds `drafts` fixed while it is open): what the person
  // confirms is what was read here.
  useEffect(() => {
    let cancelled = false;
    const settle = (activityId: string, value: ReviewedDraft) => {
      if (!cancelled) setReviewed((previous) => new Map(previous).set(activityId, value));
    };
    for (const { row, tickedHash } of drafts) {
      void reviewTickedDraft(
        () => getQueueItem({ environmentId, input: { activityId: row.activityId } }),
        tickedHash,
      ).then((reviewedDraft) => {
        settle(row.activityId, reviewedDraft);
        if (reviewedDraft.status === "refused" && !cancelled) onUntick(row.activityId);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [drafts, environmentId, getQueueItem, onUntick]);

  const ready = drafts.flatMap(({ row }) => {
    const entry = reviewed.get(row.activityId);
    return entry?.status === "ready" ? [entry.version] : [];
  });
  const loading = drafts.some(
    ({ row }) => (reviewed.get(row.activityId) ?? { status: "loading" }).status === "loading",
  );
  const blocked = device.blocked;
  const canSign = device.key !== null && device.state === "active" && blocked === null;

  const confirm = async () => {
    if (device.key === null || !canSign || ready.length === 0) return;
    setSigning(true);
    try {
      props.onDone(await approveVersions(device.key, ready));
    } finally {
      setSigning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || signing ? undefined : props.onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review before approving</DialogTitle>
          <DialogDescription>
            Each draft below is exactly what will go. Approving signs every one marked ready, on
            this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {drafts.map(({ row }) => (
            <ReviewedDraft
              key={row.activityId}
              row={row}
              reviewed={reviewed.get(row.activityId) ?? { status: "loading" }}
            />
          ))}
        </DialogPanel>
        <DialogFooter>
          {canSign ? null : (
            <p className="flex-1 self-center text-xs text-muted-foreground">
              {blocked ?? thisDeviceDescription(device.state, device.key)}
            </p>
          )}
          <Button variant="outline" disabled={signing} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSign || loading || signing || ready.length === 0}
            onClick={() => void confirm()}
          >
            {signing ? "Signing…" : `Approve ${ready.length}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReviewedDraft(props: { readonly row: SalesQueueItem; readonly reviewed: ReviewedDraft }) {
  const { row, reviewed } = props;
  const who = row.contact.name ?? row.contact.email ?? "Unknown contact";
  return (
    <section className="grid gap-2 rounded-lg border p-3" aria-label={`Draft to ${who}`}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {who}
          <span className="font-normal text-muted-foreground">
            {" "}
            · {kindLabel(row.kind)}
            {row.stepLabel ? ` · ${row.stepLabel}` : ""}
          </span>
        </h3>
        {reviewed.status === "loading" ? <Spinner /> : null}
        {reviewed.status === "ready" ? <Badge variant="success">Ready</Badge> : null}
        {reviewed.status === "refused" ? (
          <Badge variant="warning">Changed · not signed</Badge>
        ) : null}
        {reviewed.status === "unreadable" ? (
          <Badge variant="error">Not read · not signed</Badge>
        ) : null}
      </div>
      {reviewed.status === "ready" ? (
        <ShownDraft detail={reviewed.detail} />
      ) : reviewed.status === "loading" ? null : (
        <p className="text-xs text-muted-foreground">{reviewed.text}</p>
      )}
    </section>
  );
}

/** The hash inputs as they are, white space and all, never cut. */
function ShownDraft({ detail }: { readonly detail: SalesQueueItemDetail }) {
  const shown = displayedDraft(detail);
  return (
    <dl className="grid gap-1.5 text-sm">
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">To</dt>
        <dd className="min-w-0 break-all whitespace-pre-wrap">{shown.to}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">Subject</dt>
        <dd className="min-w-0 break-words whitespace-pre-wrap">{shown.subject}</dd>
      </div>
      <div className="grid gap-1">
        <dt className="text-muted-foreground">Body</dt>
        <dd className="rounded-md border p-2 break-words whitespace-pre-wrap">{shown.body}</dd>
      </div>
    </dl>
  );
}
