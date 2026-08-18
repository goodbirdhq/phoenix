import type { OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, FileTextIcon, InboxIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  deriveSessionReportInboxChildren,
  deriveSessionReportNotifications,
  visibleSessionReportInboxChildren,
} from "../../lib/sessionReportNotifications";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export const SESSION_REPORT_INBOX_PASSIVE_COPY =
  "Opening this inbox or a child thread does not mark a report as read. Only the parent agent's read_report call clears an update.";

export function SessionReportDigest({
  activities,
  onOpenChildThread,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onOpenChildThread: (threadId: ThreadId) => void;
}) {
  const notifications = useMemo(() => deriveSessionReportNotifications(activities), [activities]);
  const children = useMemo(() => deriveSessionReportInboxChildren(notifications), [notifications]);
  const visibleChildren = useMemo(() => visibleSessionReportInboxChildren(children), [children]);
  const failedCount = useMemo(
    () => notifications.filter((notification) => notification.payload.status === "failure").length,
    [notifications],
  );

  if (notifications.length === 0) return null;

  const countLabel = `${notifications.length} child report${notifications.length === 1 ? "" : "s"} awaiting parent review`;
  const needsAttentionLabel =
    failedCount === 0 ? null : `${failedCount} ${failedCount === 1 ? "needs" : "need"} attention`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Open child report inbox: ${countLabel}${needsAttentionLabel ? `, ${needsAttentionLabel}` : ""}`}
        aria-description="Opening this inbox does not mark reports as read."
        className="chat-composer-glass mb-2 flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-left text-sm shadow-sm transition-colors hover:border-border hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          {failedCount > 0 ? (
            <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
          ) : (
            <InboxIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium text-foreground">{countLabel}</span>
        </span>
        {needsAttentionLabel ? (
          <span className="shrink-0 text-destructive text-xs">{needsAttentionLabel}</span>
        ) : (
          <span className="shrink-0 text-muted-foreground text-xs">Open inbox</span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        align="center"
        className="w-[min(34rem,calc(100vw-2rem))]"
        viewportClassName="max-h-[min(28rem,calc(100vh-10rem))]"
      >
        <div className="space-y-1">
          <div className="flex items-start gap-2 px-1 pb-2">
            <InboxIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium text-foreground text-sm">Child report inbox</p>
              <p className="text-muted-foreground text-xs">{SESSION_REPORT_INBOX_PASSIVE_COPY}</p>
            </div>
          </div>
          <ul className="space-y-1" aria-label="Unread child reports">
            {visibleChildren.map((child) => {
              const isFailure = child.latest.payload.status === "failure";
              const relativeTime = formatRelativeTimeLabel(child.latest.createdAt);
              return (
                <li key={child.childThreadId}>
                  <button
                    type="button"
                    onClick={() => onOpenChildThread(child.childThreadId)}
                    className="group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isFailure ? (
                      <CircleAlertIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-destructive"
                      />
                    ) : (
                      <FileTextIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-medium text-foreground text-sm">
                          {child.childTitle}
                        </span>
                        {relativeTime ? (
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {relativeTime}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-muted-foreground text-xs">
                        {child.latest.payload.reportTitle ?? child.latest.summary}
                      </span>
                      {child.unreadCount > 1 ? (
                        <span className="mt-1 block text-muted-foreground text-xs">
                          {child.unreadCount} unread updates from this child
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {children.length > visibleChildren.length ? (
            <p className="px-2 pt-2 text-muted-foreground text-xs">
              Showing {visibleChildren.length} children; {children.length - visibleChildren.length}{" "}
              more still have unread reports.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
