import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import { CircleAlertIcon, ClockIcon, FileTextIcon, InboxIcon, MailIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  deriveSessionReportInboxChildren,
  deriveSessionReportNotifications,
  visibleSessionReportInboxChildren,
} from "../../lib/sessionReportNotifications";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export const SESSION_REPORT_INBOX_PASSIVE_COPY =
  "Only reports the parent agent has not yet taken in. An update clears once the agent receives the report in a turn or reads it with read_report — opening this inbox or a child thread clears nothing.";

/**
 * How long the exit animation runs before the icon unmounts. Kept in sync with
 * the `session-inbox-exit` keyframe so the element is not torn out mid-flight.
 */
const EXIT_ANIMATION_MS = 180;

type IconPhase = "hidden" | "visible" | "leaving";

/** One line of a message still sitting in this thread's delivery queue. */
interface PendingChatEntry {
  readonly messageId: string;
  readonly from: string;
  readonly preview: string;
  readonly requestedAt: string;
}

const messagePreview = (text: string): string => {
  const line = text.split(/\r?\n/u, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length <= 96 ? line : `${line.slice(0, 95).trimEnd()}…`;
};

/**
 * Joins the thread's undelivered queue with its messages: what is still
 * waiting for the agent, who said it, and since when. Origin distinguishes
 * a child session's queued question from the human's queued follow-up.
 */
export const derivePendingChats = (
  queuedTurnStarts: OrchestrationThread["queuedTurnStarts"] | null | undefined,
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<PendingChatEntry> => {
  if (queuedTurnStarts === null || queuedTurnStarts === undefined) return [];
  const byId = new Map(messages.map((message) => [message.id as string, message]));
  return queuedTurnStarts.map((entry) => {
    const message = byId.get(entry.messageId as string);
    const origin = message?.origin;
    return {
      messageId: entry.messageId,
      from:
        origin === undefined ? "You" : origin.kind === "phoenix" ? "Phoenix" : "Another session",
      preview: message !== undefined ? messagePreview(message.text) : "Queued message",
      requestedAt: entry.requestedAt,
    };
  });
};

export function SessionReportDigest({
  activities,
  queuedTurnStarts = null,
  messages = [],
  onOpenChildThread,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly queuedTurnStarts?: OrchestrationThread["queuedTurnStarts"] | null;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
  readonly onOpenChildThread: (threadId: ThreadId) => void;
}) {
  const notifications = useMemo(() => deriveSessionReportNotifications(activities), [activities]);
  const children = useMemo(() => deriveSessionReportInboxChildren(notifications), [notifications]);
  const visibleChildren = useMemo(() => visibleSessionReportInboxChildren(children), [children]);
  const failedCount = useMemo(
    () => notifications.filter((notification) => notification.payload.status === "failure").length,
    [notifications],
  );
  const pendingChats = useMemo(
    () => derivePendingChats(queuedTurnStarts, messages),
    [queuedTurnStarts, messages],
  );

  const count = notifications.length + pendingChats.length;
  const [phase, setPhase] = useState<IconPhase>(count > 0 ? "visible" : "hidden");
  // Bumped on each arrival so React remounts the icon and replays the one-shot
  // flash. Same trick as the prompt-stash counter: no looping animation, which
  // would repaint forever on a high-refresh display for as long as a report
  // sits unread.
  const [flashKey, setFlashKey] = useState(0);
  const previousCount = useRef(count);
  // The counts that were true while the icon was still earning its place. The
  // exit renders from these: by then the real counts are zero, and animating
  // out an icon relabelled "0 child reports" (badge already gone) would be
  // both wrong to a screen reader and visibly jumpy.
  const lastPresent = useRef({ count, failedCount });

  useEffect(() => {
    if (count > 0) lastPresent.current = { count, failedCount };
  }, [count, failedCount]);

  useEffect(() => {
    const previous = previousCount.current;
    previousCount.current = count;
    if (count > previous) {
      setPhase("visible");
      setFlashKey((key) => key + 1);
      return;
    }
    if (count === 0 && previous > 0) setPhase("leaving");
  }, [count]);

  // Unmount after the exit animation. A timer rather than onAnimationEnd so a
  // reduced-motion user, whose animation never runs, still sees it disappear.
  useEffect(() => {
    if (phase !== "leaving") return;
    const timer = setTimeout(() => setPhase("hidden"), EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (count === 0 && phase !== "leaving") return null;

  const shownCount = count > 0 ? count : lastPresent.current.count;
  const shownFailedCount = count > 0 ? failedCount : lastPresent.current.failedCount;
  const countLabel = `${shownCount} update${shownCount === 1 ? "" : "s"} awaiting this agent`;
  const needsAttentionLabel =
    shownFailedCount === 0
      ? null
      : `${shownFailedCount} ${shownFailedCount === 1 ? "needs" : "need"} attention`;

  return (
    <Popover>
      <div className="mb-2 flex justify-end">
        <PopoverTrigger
          key={flashKey}
          aria-label={`Open child report inbox: ${countLabel}${needsAttentionLabel ? `, ${needsAttentionLabel}` : ""}`}
          aria-description="Opening this inbox does not mark reports as read."
          className={cn(
            "chat-composer-glass relative flex size-8 items-center justify-center rounded-full border border-border/60 text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-accent/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            shownFailedCount > 0 && "border-destructive/50 text-destructive",
            phase === "leaving" ? "session-inbox-icon-exit" : "session-inbox-icon-enter",
          )}
        >
          {shownFailedCount > 0 ? (
            <CircleAlertIcon aria-hidden className="size-4" />
          ) : (
            <MailIcon aria-hidden className="size-4" />
          )}
          {shownCount > 1 ? (
            <span
              aria-hidden
              className={cn(
                "-top-1 -right-1 absolute flex min-w-4 items-center justify-center rounded-full px-1 font-medium text-[10px] leading-4 tabular-nums",
                shownFailedCount > 0
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-foreground text-background",
              )}
            >
              {shownCount > 9 ? "9+" : shownCount}
            </span>
          ) : null}
          {/* Announced separately so the visual reduces to an icon without
              costing screen-reader users the count and failure state. */}
          <span className="sr-only">
            {countLabel}
            {needsAttentionLabel ? `, ${needsAttentionLabel}` : ""}
          </span>
        </PopoverTrigger>
      </div>
      <PopoverPopup
        // Anchored to the composer's right edge: the trigger lives at the
        // right end of the chat box, and a centered popup detaches from it.
        side="top"
        align="end"
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
          {pendingChats.length > 0 ? (
            <div className="space-y-1 pb-1">
              <p className="px-1 text-[.65rem] font-medium tracking-wider text-muted-foreground uppercase">
                Waiting for the agent
              </p>
              <ul className="space-y-1" aria-label="Messages waiting for the agent">
                {pendingChats.map((chat) => (
                  <li
                    key={chat.messageId}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5"
                  >
                    <ClockIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-medium text-foreground text-sm">
                          {chat.from}
                        </span>
                        <span className="shrink-0 text-muted-foreground text-xs">
                          {formatRelativeTimeLabel(chat.requestedAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-muted-foreground text-xs">
                        {chat.preview}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
