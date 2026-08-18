import { EventId, type SessionReportNotificationActivity, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SESSION_REPORT_INBOX_PASSIVE_COPY, SessionReportDigest } from "./SessionReportDigest";

const reportActivity = {
  id: EventId.make("report-activity"),
  tone: "info",
  kind: "session-report.posted",
  summary: "Child posted report",
  payload: {
    childThreadId: ThreadId.make("child-thread"),
    childTitle: "Child",
    reportId: "report-1",
    reportTitle: "Finished work",
    status: "success",
    origin: "agent",
    createdAt: "2026-08-17T00:00:00.000Z",
  },
  turnId: null,
  sequence: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
} as SessionReportNotificationActivity;

describe("SessionReportDigest", () => {
  it("labels the popover as passive rather than pretending opening it consumes a report", () => {
    const markup = renderToStaticMarkup(
      <SessionReportDigest activities={[reportActivity]} onOpenChildThread={() => undefined} />,
    );

    expect(SESSION_REPORT_INBOX_PASSIVE_COPY).toBe(
      "Opening this inbox or a child thread does not mark a report as read. Only the parent agent's read_report call clears an update.",
    );
    expect(markup).toContain("Opening this inbox does not mark reports as read.");
    expect(markup).toContain("1 child report awaiting parent review");
  });
});
