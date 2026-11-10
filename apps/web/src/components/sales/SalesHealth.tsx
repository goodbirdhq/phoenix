import {
  healthLines,
  mailboxFacts,
  mailboxState,
  mailboxStatusLabel,
  mailboxStatusTone,
  poolLine,
} from "@t3tools/client-runtime/sales/health";
import { salesTime } from "@t3tools/client-runtime/sales/time";
import type { EnvironmentId, SalesMailbox, SalesMailboxList } from "@t3tools/contracts";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import { useNowMs } from "../../hooks/useNowMinute";
import { useSalesView } from "../../state/sales";
import { Badge } from "../ui/badge";
import { SalesViewPage, SalesViewRead } from "./SalesViewFrame";

/**
 * The engine's health check as it would read now, and the mailbox pool. Read-only. Each is its
 * own engine list, so either shows while the other is missing.
 */
export function SalesHealth({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const now = useNowMs();
  return (
    <SalesViewPage title="Health">
      <EngineHealth environmentId={environmentId} />
      <SalesMailboxes environmentId={environmentId} now={now} />
    </SalesViewPage>
  );
}

function EngineHealth({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { read, failed } = useSalesView(environmentId, "health");
  return (
    <section aria-label="Engine" className="space-y-2">
      <SalesViewRead name="Engine health" read={read} failed={failed} inline>
        {(health) => {
          const [headline, ...findings] = healthLines(health.text);
          return (
            <>
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
                  {findings.map((line, index) => (
                    // Findings are lines of one message: fixed in place, and two can read the same.
                    // oxlint-disable-next-line react/no-array-index-key
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          );
        }}
      </SalesViewRead>
    </section>
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
      <SalesViewRead name="Mailboxes" read={read} failed={failed} inline>
        {(mailboxes) => (
          <ul className="divide-y rounded-lg border">
            {mailboxes.items.map((mailbox) => (
              <MailboxRow key={mailbox.address} mailbox={mailbox} list={mailboxes} now={now} />
            ))}
          </ul>
        )}
      </SalesViewRead>
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
  const tone = mailboxStatusTone(mailbox.status);
  const synced = salesTime(mailbox.lastSyncedAt, now)?.local ?? null;
  return (
    <li className="space-y-0.5 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm">{mailbox.address}</span>
        {tone ? <Badge variant={tone}>{mailboxStatusLabel(mailbox.status)}</Badge> : null}
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
      <p className="text-xs text-muted-foreground">
        {mailboxFacts(mailbox, props.list.bounceRule, now)}
      </p>
      {mailbox.statusReason ? (
        <p className="text-xs text-muted-foreground">{mailbox.statusReason}</p>
      ) : null}
    </li>
  );
}
