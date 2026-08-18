import {
  EventId,
  type OrchestrationThreadActivity,
  type SessionReportNotificationActivity,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  deriveSessionReportInboxChildren,
  deriveSessionReportNotifications,
  SESSION_REPORT_DIGEST_MAX_ITEMS,
  visibleSessionReportInboxChildren,
} from "./sessionReportNotifications";

const activity = (id: string, sequence: number): SessionReportNotificationActivity =>
  ({
    id: EventId.make(id),
    tone: "info",
    kind: "session-report.posted",
    summary: `Child posted report ${id}`,
    payload: {
      childThreadId: ThreadId.make("child-thread"),
      childTitle: "Child",
      reportId: id,
      status: "success",
      origin: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    turnId: null,
    sequence,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as SessionReportNotificationActivity;

const consumed = (reportId: string, sequence: number): OrchestrationThreadActivity =>
  ({
    id: EventId.make(`read-${reportId}`),
    tone: "info",
    kind: "session-report.read",
    summary: "Parent agent read child report",
    payload: {
      childThreadId: ThreadId.make("child-thread"),
      reportId,
      readByThreadId: ThreadId.make("parent-thread"),
      readAt: "2026-01-01T00:00:00.000Z",
    },
    turnId: null,
    sequence,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as OrchestrationThreadActivity;

describe("deriveSessionReportNotifications", () => {
  it("keeps every report update in durable activity order and ignores unrelated activity", () => {
    const notifications = deriveSessionReportNotifications([
      { ...activity("report-2", 2) },
      {
        ...activity("tool", 1),
        kind: "tool.started",
        payload: { toolName: "rg" },
      },
      activity("report-1", 1),
    ]);

    expect(notifications.map((entry) => entry.payload.reportId)).toEqual(["report-1", "report-2"]);
  });

  it("keeps only current reports", () => {
    const amended = activity("report-amended", 99);
    const notifications = deriveSessionReportNotifications(
      Array.from({ length: SESSION_REPORT_DIGEST_MAX_ITEMS + 2 }, (_unused, index) =>
        activity(`report-${index}`, index),
      ).concat({
        ...amended,
        payload: {
          childThreadId: ThreadId.make("child-thread"),
          childTitle: "Child",
          reportId: "report-amended",
          status: "success",
          origin: "agent",
          createdAt: "2026-01-01T00:00:00.000Z",
          supersedesReportId: "report-0",
        },
      }),
    );
    expect(notifications.some((entry) => entry.payload.reportId === "report-0")).toBe(false);
    expect(notifications).toHaveLength(SESSION_REPORT_DIGEST_MAX_ITEMS + 2);
  });

  it("keeps legacy posted reports unread until the parent agent consumes their report id", () => {
    const notifications = deriveSessionReportNotifications([
      activity("legacy-report", 1),
      activity("current-report", 2),
      consumed("current-report", 3),
    ]);

    expect(notifications.map((entry) => entry.payload.reportId)).toEqual(["legacy-report"]);
  });

  it("consumes an amendment only when its own report id is read", () => {
    const original = activity("report-original", 1);
    const amendment = {
      ...activity("report-amendment", 2),
      payload: {
        ...activity("report-amendment", 2).payload,
        supersedesReportId: "report-original",
      },
    };

    expect(
      deriveSessionReportNotifications([original, amendment, consumed("report-original", 3)]).map(
        (entry) => entry.payload.reportId,
      ),
    ).toEqual(["report-amendment"]);
    expect(
      deriveSessionReportNotifications([original, amendment, consumed("report-amendment", 3)]),
    ).toEqual([]);
  });

  it("collapses the compact inbox to the latest unread report per child without losing count", () => {
    const latest = {
      ...activity("report-2", 2),
      payload: {
        ...activity("report-2", 2).payload,
        childThreadId: ThreadId.make("child-a"),
        childTitle: "Child A",
      },
    };
    const other = {
      ...activity("report-3", 3),
      payload: {
        ...activity("report-3", 3).payload,
        childThreadId: ThreadId.make("child-b"),
        childTitle: "Child B",
      },
    };
    const children = deriveSessionReportInboxChildren([
      {
        ...activity("report-1", 1),
        payload: {
          ...activity("report-1", 1).payload,
          childThreadId: ThreadId.make("child-a"),
          childTitle: "Child A",
        },
      },
      latest,
      other,
    ]);

    expect(children).toEqual([
      expect.objectContaining({
        childThreadId: "child-b",
        unreadCount: 1,
        latest: other,
      }),
      expect.objectContaining({
        childThreadId: "child-a",
        unreadCount: 2,
        latest,
      }),
    ]);
  });

  it("uses the latest child title when a child posts another unread report", () => {
    const children = deriveSessionReportInboxChildren([
      {
        ...activity("report-earlier", 1),
        payload: {
          ...activity("report-earlier", 1).payload,
          childTitle: "Original child title",
        },
      },
      {
        ...activity("report-later", 2),
        payload: {
          ...activity("report-later", 2).payload,
          childTitle: "Renamed child title",
        },
      },
    ]);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      childTitle: "Renamed child title",
      latest: { payload: { reportId: "report-later" } },
      unreadCount: 2,
    });
  });

  it("keeps a large inbox bounded to the newest children", () => {
    const children = deriveSessionReportInboxChildren(
      Array.from({ length: SESSION_REPORT_DIGEST_MAX_ITEMS + 3 }, (_unused, index) => ({
        ...activity(`report-${index}`, index),
        payload: {
          ...activity(`report-${index}`, index).payload,
          childThreadId: ThreadId.make(`child-${index}`),
          childTitle: `Child ${index}`,
        },
      })),
    );

    const visible = visibleSessionReportInboxChildren(children);
    expect(visible).toHaveLength(SESSION_REPORT_DIGEST_MAX_ITEMS);
    expect(visible[0]?.childThreadId).toBe("child-22");
    expect(visible.at(-1)?.childThreadId).toBe("child-3");
  });
});
