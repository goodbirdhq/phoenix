import { OccurrenceId, ThreadId, type ScheduleHistoryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  latestScheduleHistoryListText,
  mergeOlderScheduleHistory,
  prependOlderScheduleHistory,
} from "./history.ts";

const triggered = (suffix: string, at: string): ScheduleHistoryEntry => ({
  type: "triggered",
  occurrenceId: OccurrenceId.make(`018fd1b2-6610-7e39-8f09-468fa24c8c${suffix}`),
  scheduledFor: at,
  triggeredAt: at,
  threadId: ThreadId.make(`thread-${suffix}`),
});

describe("Schedule history presentation", () => {
  it("deduplicates page boundaries for both active client windows", () => {
    const oldest = triggered("01", "2026-08-19T08:00:00.000Z");
    const boundary = triggered("02", "2026-08-19T09:00:00.000Z");
    const recent = triggered("03", "2026-08-19T10:00:00.000Z");

    expect(prependOlderScheduleHistory([oldest, boundary], [boundary, recent], 4)).toEqual([
      oldest,
      boundary,
      recent,
    ]);
    expect(
      mergeOlderScheduleHistory({
        currentOlder: [boundary],
        page: [oldest, boundary],
        recent: [recent],
        maximum: 3,
      }),
    ).toEqual([oldest, boundary]);
  });

  it("uses one shared latest-history label", () => {
    expect(latestScheduleHistoryListText(triggered("04", "now"), (value) => value)).toBe(
      "Triggered · now",
    );
  });
});
