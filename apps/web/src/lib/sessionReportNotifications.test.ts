import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { deriveSessionReportNotifications } from "./sessionReportNotifications";

const activity = (id: string, sequence: number): OrchestrationThreadActivity =>
  ({
    id: EventId.make(id),
    tone: "info",
    kind: "session-report.posted",
    summary: `Child posted report ${id}`,
    payload: {
      childThreadId: "child-thread",
      childTitle: "Child",
      reportId: id,
      status: "success",
      origin: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
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
});
