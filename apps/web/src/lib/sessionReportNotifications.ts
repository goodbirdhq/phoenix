import {
  isSessionReportNotificationActivity,
  type OrchestrationThreadActivity,
  type SessionReportNotificationActivity,
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
  return [...latestByReportId.values()].filter(
    (activity) => !superseded.has(activity.payload.reportId),
  );
};

export const SESSION_REPORT_DIGEST_MAX_ITEMS = 20;

export const visibleSessionReportNotifications = (
  notifications: ReadonlyArray<SessionReportNotificationActivity>,
) => notifications.slice(-SESSION_REPORT_DIGEST_MAX_ITEMS);
