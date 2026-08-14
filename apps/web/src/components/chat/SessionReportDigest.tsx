import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveSessionReportNotifications } from "../../lib/sessionReportNotifications";

export function SessionReportDigest({
  activities,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const notifications = deriveSessionReportNotifications(activities);
  if (notifications.length === 0) return null;

  return (
    <section
      aria-label="Child session report updates"
      className="border-b border-border/60 bg-muted/30 px-4 py-2 text-sm"
    >
      <p className="font-medium text-foreground">
        {notifications.length} child report update{notifications.length === 1 ? "" : "s"} available
      </p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {notifications.map((notification) => (
          <li key={notification.id}>
            <span className="text-foreground">{notification.payload.childTitle}</span>:{" "}
            {notification.summary} <code className="text-xs">{notification.payload.reportId}</code>
            {notification.payload.supersedesReportId ? (
              <span> (supersedes {notification.payload.supersedesReportId})</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">
        Read current details with <code>read_report</code> or <code>read_session</code>.
      </p>
    </section>
  );
}
