import {
  isSessionReportNotificationActivity,
  type OrchestrationThreadActivity,
  type SessionReportNotificationActivity,
} from "@t3tools/contracts";

export const deriveSessionReportNotifications = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SessionReportNotificationActivity> =>
  activities.filter(isSessionReportNotificationActivity).toSorted((left, right) => {
    if (left.sequence !== undefined && right.sequence !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
