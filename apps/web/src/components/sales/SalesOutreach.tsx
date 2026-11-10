import {
  listedVersionMatches,
  verifyDisplayedVersion,
} from "@t3tools/client-runtime/sales/approval";
import { thisDeviceDescription } from "@t3tools/client-runtime/sales/devices";
import {
  groupQueue,
  kindLabel,
  queueOrder,
  stateLabel,
} from "@t3tools/client-runtime/sales/outreach";
import type { EnvironmentId, SalesDispatch, SalesQueueItem } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
  readSalesFailure,
  salesEnvironment,
  useSalesDevice,
  useSalesState,
} from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import type { ApproveOutcome } from "./salesApproval";
import { useApproveVersions } from "./salesApproval";
import { SalesDraftPanel, type SalesDraftPanelHandle } from "./SalesDraftPanel";
import { setSalesPaletteCommands } from "./salesPaletteCommands";
import { useSalesListKeys } from "./useSalesListKeys";

/**
 * Drafts waiting on a person: the list grouped by campaign, the selected draft editable in
 * place, and what the engine knows about how it came about.
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
  const panel = useRef<SalesDraftPanelHandle>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<ApproveOutcome>>([]);
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  const approveVersions = useApproveVersions(environmentId);
  const dispatches = snapshot?.dispatches ?? [];

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

  useSalesListKeys({
    next: () => moveRef.current(1),
    previous: () => moveRef.current(-1),
    approve: () => panel.current?.approve(),
    edit: () => panel.current?.focusBody(),
  });

  // Registered once; each command reaches the current list and draft through refs.
  useEffect(() => {
    setSalesPaletteCommands([
      {
        id: "sales:approve",
        title: "Approve the selected draft",
        keywords: ["sales", "approve", "draft", "outreach", "sign"],
        shortcut: "A",
        run: () => panel.current?.approve(),
      },
      {
        id: "sales:edit",
        title: "Edit the selected draft",
        keywords: ["sales", "edit", "draft", "outreach"],
        shortcut: "E",
        run: () => panel.current?.focusBody(),
      },
      {
        id: "sales:next",
        title: "Next draft",
        keywords: ["sales", "next", "down", "draft"],
        shortcut: "J",
        run: () => moveRef.current(1),
      },
      {
        id: "sales:previous",
        title: "Previous draft",
        keywords: ["sales", "previous", "up", "draft"],
        shortcut: "K",
        run: () => moveRef.current(-1),
      },
    ]);
    return () => setSalesPaletteCommands([]);
  }, []);

  const approvable = order.filter(
    (item) => checked.has(item.activityId) && item.state === "awaiting",
  );

  /**
   * Each checked draft is read again and signed on its own, and only when it is still the
   * version the list shows. A row that moved on is left for the person to read again.
   */
  const approveChecked = async () => {
    if (device.key === null || device.state !== "active" || approvable.length === 0) return;
    setBatchBusy(true);
    const refused: ApproveOutcome[] = [];
    const versions: Array<{ activityId: string; contentHash: string }> = [];
    try {
      for (const row of approvable) {
        const result = await getQueueItem({ environmentId, input: { activityId: row.activityId } });
        if (result._tag !== "Success") {
          refused.push({
            activityId: row.activityId,
            ok: false,
            text: readSalesFailure(result)?.description ?? "Could not read it.",
            stale: false,
          });
          continue;
        }
        const verified = await verifyDisplayedVersion(result.value);
        if (!listedVersionMatches(row, result.value) || !verified.ok) {
          refused.push({
            activityId: row.activityId,
            ok: false,
            text: "It changed since the list was read. Open it and look before approving.",
            stale: true,
          });
          continue;
        }
        versions.push({ activityId: row.activityId, contentHash: verified.contentHash });
      }
      const approved = versions.length > 0 ? await approveVersions(device.key, versions) : [];
      const all = [...approved, ...refused];
      setOutcomes(all);
      setChecked(
        new Set(all.filter((outcome) => !outcome.ok).map((outcome) => outcome.activityId)),
      );
    } finally {
      setBatchBusy(false);
    }
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
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)_minmax(15rem,19rem)]">
      <aside
        aria-label="Drafts waiting"
        className="flex min-h-0 flex-col border-b md:border-r md:border-b-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1 text-xs text-muted-foreground">
            {order.length === 0 ? "Nothing waits" : `${order.length} open`}
            {snapshot?.status !== "ready" && snapshot?.message ? " · stale" : ""}
          </span>
          {canAct && checked.size > 0 ? (
            <Button
              size="xs"
              disabled={batchBusy || device.state !== "active" || approvable.length === 0}
              onClick={() => void approveChecked()}
            >
              {batchBusy ? "Signing…" : `Approve ${approvable.length}`}
            </Button>
          ) : null}
        </div>
        {canAct && checked.size > 0 && device.state !== "active" ? (
          <p className="border-b px-3 py-2 text-xs text-muted-foreground">
            {thisDeviceDescription(device.state, device.key)}
          </p>
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
                    checkable={canAct && item.state === "awaiting"}
                    checked={checked.has(item.activityId)}
                    onCheck={(value) =>
                      setChecked((previous) => {
                        const next = new Set(previous);
                        if (value) next.add(item.activityId);
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
        <p className="hidden border-t px-3 py-2 text-xs text-muted-foreground md:block">
          <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>A</Kbd> approve · <Kbd>E</Kbd> edit
        </p>
      </aside>

      {current ? (
        <SalesDraftPanel
          key={current.activityId}
          ref={panel}
          environmentId={environmentId}
          activityId={current.activityId}
          listedHash={current.contentHash}
          canAct={canAct}
          device={device}
          dispatches={dispatches}
          allowResearch
        />
      ) : (
        <div className="hidden md:block" />
      )}

      {current ? (
        <SalesContextPanel
          item={current}
          environmentId={environmentId}
          dispatches={dispatches.filter((entry) => entry.target === current.activityId)}
        />
      ) : null}
    </div>
  );
}

function QueueRow(props: {
  readonly item: SalesQueueItem;
  readonly selected: boolean;
  readonly checkable: boolean;
  readonly checked: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onSelect: () => void;
}) {
  const { item } = props;
  const who = item.contact.name ?? item.contact.email ?? "Unknown contact";
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
          {item.state === "awaiting" ? null : (
            <Badge
              size="sm"
              variant={
                item.state === "approved"
                  ? "success"
                  : item.state === "refused"
                    ? "error"
                    : "secondary"
              }
            >
              {stateLabel(item.state)}
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

function ContextSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-1">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      <div className="grid gap-1 text-sm">{children}</div>
    </section>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

const safeHttpUrl = (value: string | null) =>
  value !== null && value.startsWith("https://") && URL.canParse(value) ? value : null;

/**
 * Who the draft is to and how it came about, from what the engine carries. The engine has no
 * research, sources or job title for a draft, so those say where to look instead.
 */
function SalesContextPanel(props: {
  readonly item: SalesQueueItem;
  readonly environmentId: EnvironmentId;
  readonly dispatches: ReadonlyArray<SalesDispatch>;
}) {
  const { item } = props;
  const contactPage = safeHttpUrl(item.contact.notionUrl);
  const rowPage = safeHttpUrl(item.notionUrl);
  const linkedin = safeHttpUrl(item.contact.linkedinUrl);
  return (
    <aside
      aria-label="About this draft"
      className="hidden min-h-0 flex-col gap-5 overflow-y-auto border-l p-4 xl:flex"
    >
      <ContextSection title="Person">
        <p>{item.contact.name ?? "No name on the card"}</p>
        {item.contact.accountName ? (
          <p className="text-muted-foreground">{item.contact.accountName}</p>
        ) : null}
        {item.contact.email ? (
          <p className="text-xs text-muted-foreground">{item.contact.email}</p>
        ) : null}
        {item.contact.effectiveTimeZone ? (
          <p className="text-xs text-muted-foreground">
            Sends timed in {item.contact.effectiveTimeZone}
          </p>
        ) : null}
        {linkedin ? (
          <ExternalLink href={linkedin}>LinkedIn</ExternalLink>
        ) : (
          <p className="text-xs text-muted-foreground">
            No LinkedIn link: the engine carries none for drafts.
          </p>
        )}
      </ContextSection>
      <ContextSection title="Why this person">
        <p className="text-xs text-muted-foreground">
          The engine does not carry the research or its sources. They are on the Contact's page in
          Notion.
        </p>
        {contactPage ? <ExternalLink href={contactPage}>Contact in Notion</ExternalLink> : null}
      </ContextSection>
      <ContextSection title="How it came about">
        {item.campaign ? <p>Campaign: {item.campaign}</p> : null}
        {item.stepLabel ? <p>{item.stepLabel} to them</p> : null}
        {rowPage ? <ExternalLink href={rowPage}>Activity row in Notion</ExternalLink> : null}
        {props.dispatches.length > 0 ? (
          props.dispatches.map((dispatch) => (
            <Link
              key={dispatch.threadId}
              to="/$environmentId/$threadId"
              params={{ environmentId: props.environmentId, threadId: dispatch.threadId }}
              className="underline"
            >
              {dispatch.title}
            </Link>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            The run that drafted it is not known: the engine does not record it.
          </p>
        )}
      </ContextSection>
      <ContextSection title="Mailbox">
        <p className="text-xs">
          {item.mailbox.sticky && item.mailbox.address
            ? `Leaves from ${item.mailbox.address}`
            : "Any active mailbox (first touch)"}
          {item.mailbox.threadState ? ` · thread ${item.mailbox.threadState}` : ""}
        </p>
      </ContextSection>
    </aside>
  );
}
