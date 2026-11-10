import { checkSigning } from "@t3tools/client-runtime/sales/devices";
import {
  cardActions,
  groupQueue,
  holdLabel,
  kindLabel,
  queueOrder,
  queueRowStatus,
  queueSummary,
  tickedForReview,
} from "@t3tools/client-runtime/sales/outreach";
import type { EnvironmentId, SalesQueueItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { salesTime } from "@t3tools/client-runtime/sales/time";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useNowMs } from "../../hooks/useNowMinute";
import { useSalesDevice, useSalesState } from "../../state/sales";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import type { ApproveOutcome } from "@t3tools/client-runtime/sales/approve";
import { SalesBatchReview, type TickedDraft } from "./SalesBatchReview";
import { SalesDraftPanel, type SalesDraftPanelHandle } from "./SalesDraftPanel";
import { setSalesPaletteCommands } from "./salesPaletteCommands";
import type { SalesShortcutCommand } from "./salesShortcuts";
import { useSalesListKeys, useSalesShortcutKeys } from "./useSalesListKeys";

/** How the command palette offers the list keys on Outreach. */
const PALETTE_TEXT: Record<
  SalesShortcutCommand,
  { readonly title: string; readonly keywords: ReadonlyArray<string> }
> = {
  "sales.next": { title: "Next draft", keywords: ["sales", "next", "down", "draft"] },
  "sales.previous": { title: "Previous draft", keywords: ["sales", "previous", "up", "draft"] },
  "sales.approve": {
    title: "Approve the selected draft",
    keywords: ["sales", "approve", "draft", "outreach", "sign"],
  },
  "sales.edit": {
    title: "Edit the selected draft",
    keywords: ["sales", "edit", "draft", "outreach"],
  },
};

/**
 * Drafts waiting on a person: the list grouped by campaign, and the selected draft read as the
 * email it will be, with what the engine knows about who it is to.
 */
export function SalesOutreach(props: {
  readonly environmentId: EnvironmentId;
  readonly baseUrl: string;
  readonly canAct: boolean;
  readonly selected: string | undefined;
  readonly onSelect: (activityId: string) => void;
}) {
  const { environmentId, canAct } = props;
  const state = useSalesState(environmentId);
  const snapshot = Option.getOrNull(state.snapshot);
  const queue = snapshot?.queue ?? null;
  const groups = useMemo(() => groupQueue(queue?.items ?? []), [queue]);
  const order = useMemo(() => queueOrder(groups), [groups]);
  const current = order.find((item) => item.activityId === props.selected) ?? order[0] ?? null;
  const device = useSalesDevice(environmentId, props.baseUrl, canAct);
  const now = useNowMs();
  const signingRefusal = checkSigning(device).refusal;
  const panel = useRef<SalesDraftPanelHandle>(null);
  /** Ticked rows, each with the hash it had when ticked: a tick covers that version only. */
  const [checked, setChecked] = useState<ReadonlyMap<string, string>>(new Map());
  const [reviewing, setReviewing] = useState<ReadonlyArray<TickedDraft> | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<ApproveOutcome>>([]);

  const move = (delta: number) => {
    if (order.length === 0) return;
    const index = current === null ? -1 : order.indexOf(current);
    const next = order[Math.min(order.length - 1, Math.max(0, index + delta))];
    if (next) props.onSelect(next.activityId);
  };

  const moveRef = useRef(move);
  useEffect(() => {
    moveRef.current = move;
  });

  // Stable, and each reaches the current list and draft through refs. Each receives when the
  // press began (keydown timestamp, or palette open); approve passes it to the swap guard.
  const actions = useMemo<Record<SalesShortcutCommand, (startedAt: number) => void>>(
    () => ({
      "sales.next": () => moveRef.current(1),
      "sales.previous": () => moveRef.current(-1),
      "sales.approve": (startedAt) => panel.current?.approve(startedAt),
      "sales.edit": () => panel.current?.edit(),
    }),
    [],
  );
  useSalesListKeys(actions);
  const shortcutKeys = useSalesShortcutKeys();

  // Hold and Resume are offered only where the selected draft's state allows them.
  const selectedActions = current !== null && canAct ? cardActions(current) : null;
  const holdTitle = current !== null && selectedActions?.hold ? holdLabel(current) : null;
  const canResume = selectedActions?.resume ?? false;

  // Registered again only when what is offered, or a key, changes.
  useEffect(() => {
    setSalesPaletteCommands([
      ...shortcutKeys.map(({ command, key }) => ({
        id: command,
        ...PALETTE_TEXT[command],
        shortcut: key,
        run: actions[command],
      })),
      ...(holdTitle === null
        ? []
        : [
            {
              id: "sales:hold",
              title: `Selected draft: ${holdTitle}`,
              keywords: ["sales", "hold", "pause", "withdraw", "approval", "draft", "outreach"],
              run: () => panel.current?.hold(),
            },
          ]),
      ...(canResume
        ? [
            {
              id: "sales:resume",
              title: "Selected draft: Resume",
              keywords: ["sales", "resume", "unpause", "autopilot", "draft", "outreach"],
              run: () => panel.current?.resume(),
            },
          ]
        : []),
    ]);
    return () => setSalesPaletteCommands([]);
  }, [actions, shortcutKeys, holdTitle, canResume]);

  const approvable = tickedForReview(order, checked);

  const untick = useCallback((activityId: string) => {
    setChecked((previous) => {
      const next = new Map(previous);
      next.delete(activityId);
      return next;
    });
  }, []);

  /** "Approve N" opens the review step; nothing is signed until it is confirmed there. */
  const reviewChecked = () => {
    if (approvable.length === 0) return;
    setOutcomes([]);
    setReviewing(approvable.map((row) => ({ row, tickedHash: checked.get(row.activityId) ?? "" })));
  };

  const finishReview = (all: ReadonlyArray<ApproveOutcome>) => {
    setReviewing(null);
    setOutcomes(all);
    // Approved rows are done, and a stale row's tick was for a version that is gone.
    setChecked((previous) => {
      const next = new Map(previous);
      for (const outcome of all) {
        if (outcome.ok || outcome.stale) next.delete(outcome.activityId);
      }
      return next;
    });
  };

  if (queue === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {snapshot?.message ? "The queue is unavailable" : "Reading the queue…"}
          </EmptyTitle>
          {snapshot?.message ? <EmptyDescription>{snapshot.message}</EmptyDescription> : null}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
      <aside
        aria-label="Drafts waiting"
        className="flex min-h-0 flex-col border-b md:border-r md:border-b-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1 text-xs text-muted-foreground">
            {queueSummary(order)}
            {snapshot?.status !== "ready" && snapshot?.message ? " · stale" : ""}
          </span>
          {canAct && approvable.length > 0 ? (
            <Button
              size="xs"
              disabled={reviewing !== null || signingRefusal !== null}
              onClick={reviewChecked}
            >
              {`Approve ${approvable.length}`}
            </Button>
          ) : null}
        </div>
        {canAct && approvable.length > 0 && signingRefusal !== null ? (
          <p className="border-b px-3 py-2 text-xs text-muted-foreground">
            {signingRefusal.description}
          </p>
        ) : null}
        {reviewing !== null ? (
          <SalesBatchReview
            environmentId={environmentId}
            drafts={reviewing}
            device={device}
            onUntick={untick}
            onDone={finishReview}
            onClose={() => setReviewing(null)}
          />
        ) : null}
        {outcomes.length > 0 ? (
          <BatchOutcomes outcomes={outcomes} order={order} onDismiss={() => setOutcomes([])} />
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {order.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing waits for approval.</p>
          ) : null}
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="sticky top-0 bg-background px-3 pt-3 pb-1 text-xs text-muted-foreground">
                {group.label}
              </h3>
              <ul>
                {group.items.map((item) => (
                  <QueueRow
                    key={item.activityId}
                    item={item}
                    selected={item.activityId === current?.activityId}
                    now={now}
                    checkable={canAct && item.state === "awaiting"}
                    // A tick shows only while the row still has the version that was ticked.
                    checked={
                      checked.get(item.activityId)?.toLowerCase() === item.contentHash.toLowerCase()
                    }
                    onCheck={(value) =>
                      setChecked((previous) => {
                        const next = new Map(previous);
                        if (value) next.set(item.activityId, item.contentHash);
                        else next.delete(item.activityId);
                        return next;
                      })
                    }
                    onSelect={() => props.onSelect(item.activityId)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <SalesKeysHint keys={shortcutKeys} />
      </aside>

      {current ? (
        <SalesDraftPanel
          key={current.activityId}
          ref={panel}
          environmentId={environmentId}
          activityId={current.activityId}
          listedHash={current.contentHash}
          listed={current}
          canAct={canAct}
          device={device}
          allowResearch
          showAbout
        />
      ) : (
        <div className="hidden md:block" />
      )}
    </div>
  );
}

const ROW_BADGE: Record<string, "warning" | "success" | "error" | "outline"> = {
  awaiting: "outline",
  approved: "success",
  paused: "warning",
  refused: "error",
};

function QueueRow(props: {
  readonly item: SalesQueueItem;
  readonly selected: boolean;
  readonly checkable: boolean;
  readonly checked: boolean;
  /** The clock "today" is read against for when a scheduled draft goes. */
  readonly now: number;
  readonly onCheck: (checked: boolean) => void;
  readonly onSelect: () => void;
}) {
  const { item } = props;
  const who = item.contact.name ?? item.contact.email ?? "Unknown contact";
  const status = queueRowStatus(item);
  return (
    <li
      aria-selected={props.selected}
      className="flex items-start gap-2 px-3 py-2 aria-selected:bg-accent"
    >
      {props.checkable ? (
        <Checkbox
          className="mt-0.5"
          aria-label={`Select the draft to ${who}`}
          checked={props.checked}
          onCheckedChange={(value) => props.onCheck(value === true)}
        />
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={props.onSelect}>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">
            {who}
            {item.contact.accountName ? (
              <span className="text-muted-foreground"> · {item.contact.accountName}</span>
            ) : null}
          </span>
          {"goesAt" in status ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {salesTime(status.goesAt, props.now)?.local}
            </span>
          ) : (
            <Badge size="sm" variant={ROW_BADGE[item.state] ?? "secondary"}>
              {status.badge}
            </Badge>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {kindLabel(item.kind)}
          {item.stepLabel ? ` · ${item.stepLabel}` : ""} · {item.subject}
        </span>
      </button>
    </li>
  );
}

function BatchOutcomes(props: {
  readonly outcomes: ReadonlyArray<ApproveOutcome>;
  readonly order: ReadonlyArray<SalesQueueItem>;
  readonly onDismiss: () => void;
}) {
  const approved = props.outcomes.filter((outcome) => outcome.ok).length;
  const names = new Map(
    props.order.map((item) => [
      item.activityId,
      item.contact.name ?? item.contact.email ?? "Draft",
    ]),
  );
  return (
    <div className="grid gap-1 border-b px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          Approved {approved} of {props.outcomes.length}.
        </span>
        <Button size="xs" variant="ghost" onClick={props.onDismiss}>
          Dismiss
        </Button>
      </div>
      {props.outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => (
          <p key={outcome.activityId} className="text-muted-foreground">
            {names.get(outcome.activityId) ?? "Draft"}: {outcome.text}
          </p>
        ))}
    </div>
  );
}

/** The list's keys as currently bound; a command with no key is left out. */
function SalesKeysHint(props: { readonly keys: ReturnType<typeof useSalesShortcutKeys> }) {
  const bound = props.keys.filter((shortcut) => shortcut.key !== null);
  if (bound.length === 0) return null;
  return (
    <p className="hidden border-t px-3 py-2 text-xs text-muted-foreground md:block">
      {bound.map(({ command, key, hint }, index) => (
        <Fragment key={command}>
          {index > 0 ? " · " : null}
          <Kbd>{key}</Kbd> {hint}
        </Fragment>
      ))}
    </p>
  );
}
