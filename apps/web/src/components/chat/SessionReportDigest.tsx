import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useMemo } from "react";
import {
  deriveSessionReportNotifications,
  visibleSessionReportNotifications,
} from "../../lib/sessionReportNotifications";

export function SessionReportDigest({
  activities,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const notifications = useMemo(() => deriveSessionReportNotifications(activities), [activities]);
  const visible = useMemo(() => visibleSessionReportNotifications(notifications), [notifications]);
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
        {visible.map((notification) => (
          <li key={notification.id}>
            <span className="text-foreground">{notification.payload.childTitle}</span>:{" "}
            {notification.summary} <code className="text-xs">{notification.payload.reportId}</code>
            {notification.payload.supersedesReportId ? (
              <span> (supersedes {notification.payload.supersedesReportId})</span>
            ) : null}
          </li>
        ))}
      </ul>
      {visible.length < notifications.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing the latest {visible.length}; {notifications.length - visible.length} earlier
          report update{notifications.length - visible.length === 1 ? "" : "s"} remain available via
          the spawned sessions.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        Read current details with <code>read_report</code> or <code>read_session</code>.
      </p>
    </section>
  );
}
