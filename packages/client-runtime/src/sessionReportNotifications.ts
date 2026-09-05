import {
  isSessionReportNotificationActivity,
  isSessionReportReadActivity,
  type OrchestrationThreadActivity,
  type SessionReportNotificationActivity,
  type ThreadId,
} from "@t3tools/contracts";

export const deriveSessionReportNotifications = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SessionReportNotificationActivity> => {
  const ordered = activities
    .filter(isSessionReportNotificationActivity)
    .toSorted((left, right) =>
      left.sequence !== undefined && right.sequence !== undefined
        ? left.sequence - right.sequence
        : left.createdAt.localeCompare(right.createdAt),
    );
  const latestByReportId = new Map<string, SessionReportNotificationActivity>();
  for (const activity of ordered) latestByReportId.set(activity.payload.reportId, activity);
  const superseded = new Set(
    [...latestByReportId.values()].flatMap((activity) =>
      activity.payload.supersedesReportId ? [activity.payload.supersedesReportId] : [],
    ),
  );
  const readReportIds = new Set(
    activities.filter(isSessionReportReadActivity).map((activity) => activity.payload.reportId),
  );
  return [...latestByReportId.values()].filter(
    (activity) =>
      !superseded.has(activity.payload.reportId) && !readReportIds.has(activity.payload.reportId),
  );
};

export const SESSION_REPORT_DIGEST_MAX_ITEMS = 20;

export interface SessionReportInboxChild {
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly latest: SessionReportNotificationActivity;
  readonly unreadCount: number;
}

export const visibleSessionReportInboxChildren = (
  children: ReadonlyArray<SessionReportInboxChild>,
) => children.slice(0, SESSION_REPORT_DIGEST_MAX_ITEMS);

export const deriveSessionReportInboxChildren = (
  notifications: ReadonlyArray<SessionReportNotificationActivity>,
): ReadonlyArray<SessionReportInboxChild> => {
  const byChild = new Map<ThreadId, SessionReportInboxChild>();
  for (const notification of notifications) {
    const previous = byChild.get(notification.payload.childThreadId);
    byChild.set(notification.payload.childThreadId, {
      childThreadId: notification.payload.childThreadId,
      childTitle: notification.payload.childTitle,
      latest: notification,
      unreadCount: (previous?.unreadCount ?? 0) + 1,
    });
  }
  return [...byChild.values()].toSorted((left, right) => {
    const leftSequence = left.latest.sequence;
    const rightSequence = right.latest.sequence;
    return leftSequence !== undefined && rightSequence !== undefined
      ? rightSequence - leftSequence
      : right.latest.createdAt.localeCompare(left.latest.createdAt);
  });
};
