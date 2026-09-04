import { EventId, type SessionReportNotificationActivity, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePendingChats,
  SESSION_REPORT_INBOX_PASSIVE_COPY,
  SessionReportDigest,
} from "./SessionReportDigest";

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

const withReportId = (reportId: string, childThreadId: string) =>
  ({
    ...reportActivity,
    id: EventId.make(`report-activity-${reportId}`),
    payload: {
      ...reportActivity.payload,
      reportId,
      childThreadId: ThreadId.make(childThreadId),
      childTitle: childThreadId,
    },
  }) as SessionReportNotificationActivity;

describe("SessionReportDigest", () => {
  it("names a routed child message from the shared thread-title map", () => {
    const chats = derivePendingChats(
      [
        {
          messageId: "message-child",
          mode: "queue",
          requestedAt: "2026-08-17T00:00:00.000Z",
        },
      ] as never,
      [
        {
          id: "message-child",
          role: "user",
          text: "Need the SHA",
          origin: { kind: "session", threadId: "child-thread" },
        },
      ] as never,
      new Map([["child-thread", "Release verifier"]]),
    );

    expect(chats[0]?.from).toBe("Release verifier");
  });

  it("labels the popover as passive rather than pretending opening it consumes a report", () => {
    const markup = renderToStaticMarkup(
      <SessionReportDigest activities={[reportActivity]} onOpenChildThread={() => undefined} />,
    );

    expect(SESSION_REPORT_INBOX_PASSIVE_COPY).toBe(
      "Only reports the parent agent has not yet taken in. An update clears once the agent receives the report in a turn or reads it with read_report — opening this inbox or a child thread clears nothing.",
    );
    expect(markup).toContain("Opening this inbox does not mark reports as read.");
  });

  it("keeps the count available to screen readers even though the trigger is only an icon", () => {
    const markup = renderToStaticMarkup(
      <SessionReportDigest activities={[reportActivity]} onOpenChildThread={() => undefined} />,
    );

    expect(markup).toContain("1 update awaiting this agent");
  });

  it("renders nothing when there is no unread report", () => {
    const markup = renderToStaticMarkup(
      <SessionReportDigest activities={[]} onOpenChildThread={() => undefined} />,
    );

    expect(markup).toBe("");
  });

  it("shows a count badge only once more than one report is waiting", () => {
    const single = renderToStaticMarkup(
      <SessionReportDigest activities={[reportActivity]} onOpenChildThread={() => undefined} />,
    );
    const many = renderToStaticMarkup(
      <SessionReportDigest
        activities={[withReportId("report-1", "child-a"), withReportId("report-2", "child-b")]}
        onOpenChildThread={() => undefined}
      />,
    );

    expect(single).not.toContain(">1</span>");
    expect(many).toContain(">2</span>");
    expect(many).toContain("2 updates awaiting this agent");
  });

  it("enters with the one-shot animation rather than a looping one", () => {
    const markup = renderToStaticMarkup(
      <SessionReportDigest activities={[reportActivity]} onOpenChildThread={() => undefined} />,
    );

    expect(markup).toContain("session-inbox-icon-enter");
  });
});
