import { healthLines, mailboxState, poolLine } from "@t3tools/client-runtime/sales/mailboxes";
import { salesTime } from "@t3tools/client-runtime/sales/time";
import type { EnvironmentId, SalesMailbox, SalesMailboxList } from "@t3tools/contracts";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSalesView } from "../../state/sales";
import { Badge } from "../ui/badge";
import { SalesViewFrame } from "./SalesViewFrame";

const STATUS_VARIANT: Record<string, "info" | "warning" | "outline"> = {
  warming: "info",
  benched: "warning",
  retired: "outline",
};

const at = (iso: string | null, now: number) => salesTime(iso, now)?.local ?? null;

/** The engine's health check as it would read now, and the mailbox pool. Read-only. */
export function SalesHealth({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { read, failed } = useSalesView(environmentId, "health");
  const now = Date.parse(`${useNowMinute()}:00Z`);
  return (
    <SalesViewFrame title="Health" read={read} failed={failed}>
      {(health) => {
        const [headline, ...findings] = healthLines(health.text);
        return (
          <>
            <section aria-label="Engine" className="space-y-2">
              <p className="flex items-start gap-2 text-sm">
                {health.healthy ? (
                  <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                )}
                <span>
                  {headline ?? (health.healthy ? "Engine healthy" : "Engine needs a look")}
                </span>
              </p>
              {findings.length > 0 ? (
                <ul className="space-y-1 pl-6 text-xs text-muted-foreground">
                  {findings.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {health.overdueRuns.length > 0 ? (
                <div className="pl-6 text-xs">
                  <p className="font-medium">Scheduled runs that have not finished</p>
                  <ul className="text-muted-foreground">
                    {health.overdueRuns.map((run) => (
                      <li key={run.workflow}>
                        {run.workflow}
                        {run.dueAt ? `, due ${at(run.dueAt, now)}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
            <SalesMailboxes environmentId={environmentId} now={now} />
          </>
        );
      }}
    </SalesViewFrame>
  );
}

function SalesMailboxes({
  environmentId,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly now: number;
}) {
  const { read, failed } = useSalesView(environmentId, "mailboxes");
  const list = read?.data ?? null;
  return (
    <section aria-label="Mailboxes" className="space-y-2">
      <h2 className="text-sm font-medium">
        Mailboxes
        {list ? (
          <span className="font-normal text-muted-foreground"> · {poolLine(list.items)}</span>
        ) : null}
      </h2>
      {list === null ? (
        <p className="text-sm text-muted-foreground">
          {failed || (read !== null && read.status !== "loading")
            ? (read?.message ?? "Could not read the mailboxes.")
            : "Reading mailboxes…"}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.items.map((mailbox) => (
            <MailboxRow key={mailbox.address} mailbox={mailbox} list={list} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MailboxRow(props: {
  readonly mailbox: SalesMailbox;
  readonly list: SalesMailboxList;
  readonly now: number;
}) {
  const { mailbox, now } = props;
  const state = mailboxState(mailbox, props.list.bounceRule, now);
  const variant = STATUS_VARIANT[mailbox.status];
  const synced = at(mailbox.lastSyncedAt, now);
  const next = state.restingUntil
    ? `Resting until ${at(state.restingUntil, now)}`
    : state.nextSendAt
      ? `Next send ${at(state.nextSendAt, now)}`
      : null;
  const facts = [
    `${mailbox.coldSentToday} of ${mailbox.dailyCap} cold today`,
    mailbox.repliesSentToday > 0 ? `${mailbox.repliesSentToday} replies` : null,
    mailbox.bouncesToday > 0 ? `${mailbox.bouncesToday} bounced today` : null,
    mailbox.hardBouncesInWindow > 0
      ? `${mailbox.hardBouncesInWindow} of ${props.list.bounceRule.threshold} hard bounces before it is benched`
      : null,
    next,
  ].filter(Boolean);
  return (
    <li className="space-y-0.5 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm">{mailbox.address}</span>
        {variant ? <Badge variant={variant}>{mailbox.status}</Badge> : null}
        {state.nearBench ? <Badge variant="warning">One bounce from benched</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {state.syncStale ? (
            <Badge variant="warning">
              {synced ? `Mail not read since ${synced}` : "Mail never read"}
            </Badge>
          ) : synced ? (
            `Synced ${synced}`
          ) : null}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
      {mailbox.statusReason ? (
        <p className="text-xs text-muted-foreground">{mailbox.statusReason}</p>
      ) : null}
    </li>
  );
}
