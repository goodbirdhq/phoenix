import {
  isSessionReportReadActivity,
  isSessionReportNotificationActivity,
  type OrchestrationThreadActivity,
  type SessionReportReadActivity,
  type SessionReportNotificationActivity,
  type ThreadId,
} from "@t3tools/contracts";

export const deriveSessionReportNotifications = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SessionReportNotificationActivity> => {
  const ordered = activities.filter(isSessionReportNotificationActivity).toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  // Delivery is at-least-once across reconnect/replay boundaries; keep only
  // the newest activity for a report ID. Amendments then hide their replaced
  // report from the actionable digest without erasing either durable report.
  const latestByReportId = new Map<string, SessionReportNotificationActivity>();
  for (const activity of ordered) latestByReportId.set(activity.payload.reportId, activity);
  const superseded = new Set(
    [...latestByReportId.values()].flatMap((activity) =>
      activity.payload.supersedesReportId ? [activity.payload.supersedesReportId] : [],
    ),
  );
  const readReportIds = new Set(
    activities
      .filter(isSessionReportReadActivity)
      .map((activity: SessionReportReadActivity) => activity.payload.reportId),
  );
  return [...latestByReportId.values()].filter(
    (activity) =>
      !superseded.has(activity.payload.reportId) && !readReportIds.has(activity.payload.reportId),
  );
};

export const SESSION_REPORT_DIGEST_MAX_ITEMS = 20;

export const visibleSessionReportNotifications = (
  notifications: ReadonlyArray<SessionReportNotificationActivity>,
) => notifications.slice(-SESSION_REPORT_DIGEST_MAX_ITEMS);

export interface SessionReportInboxChild {
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly latest: SessionReportNotificationActivity;
  readonly unreadCount: number;
}

export const visibleSessionReportInboxChildren = (
  children: ReadonlyArray<SessionReportInboxChild>,
) => children.slice(0, SESSION_REPORT_DIGEST_MAX_ITEMS);

// The chat surface gets one notification per child. Multiple independent
// reports remain unread individually, but a burst from one child cannot grow
// the composer area into a transcript; its count is visible in the popover.
export const deriveSessionReportInboxChildren = (
  notifications: ReadonlyArray<SessionReportNotificationActivity>,
): ReadonlyArray<SessionReportInboxChild> => {
  const byChild = new Map<ThreadId, SessionReportInboxChild>();
  for (const notification of notifications) {
    const previous = byChild.get(notification.payload.childThreadId);
    if (previous === undefined) {
      byChild.set(notification.payload.childThreadId, {
        childThreadId: notification.payload.childThreadId,
        childTitle: notification.payload.childTitle,
        latest: notification,
        unreadCount: 1,
      });
      continue;
    }
    byChild.set(notification.payload.childThreadId, {
      ...previous,
      latest: notification,
      unreadCount: previous.unreadCount + 1,
    });
  }
  return [...byChild.values()].toSorted((left, right) => {
    const leftSequence = left.latest.sequence;
    const rightSequence = right.latest.sequence;
    if (leftSequence !== undefined && rightSequence !== undefined) {
      return rightSequence - leftSequence;
    }
    return right.latest.createdAt.localeCompare(left.latest.createdAt);
  });
};
