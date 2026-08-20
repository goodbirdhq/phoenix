import type { ScheduleHistoryEntry } from "@t3tools/contracts";

export interface LatestScheduleHistorySummary {
  readonly label: string;
  readonly detail: string;
  readonly at: string;
}

export function latestScheduleHistorySummary(
  entry: ScheduleHistoryEntry,
): LatestScheduleHistorySummary {
  switch (entry.type) {
    case "triggered":
      return { label: "Triggered", detail: entry.scheduledFor, at: entry.triggeredAt };
    case "failed":
      return {
        label:
          entry.count === 1
            ? "Failed"
            : entry.count === 2
              ? "Failed twice"
              : `Failed ${entry.count} times`,
        detail: entry.message,
        at: entry.lastFailedAt,
      };
    case "skipped":
      return {
        label: `Skipped ${entry.countIsLowerBound ? "at least " : ""}${entry.count.toLocaleString("en-US")} Occurrences`,
        detail: `${entry.firstScheduledFor} – ${entry.lastScheduledFor}`,
        at: entry.recordedAt,
      };
  }
}

export function latestScheduleHistoryListText(
  entry: ScheduleHistoryEntry,
  formatDate: (value: string) => string,
): string {
  const summary = latestScheduleHistorySummary(entry);
  switch (entry.type) {
    case "triggered":
      return `${summary.label} · ${formatDate(entry.triggeredAt)}`;
    case "failed":
      return `${summary.label} · ${entry.message} · ${formatDate(entry.lastFailedAt)}`;
    case "skipped":
      return `${summary.label} · ${formatDate(entry.firstScheduledFor)} – ${formatDate(entry.lastScheduledFor)}`;
  }
}

export function scheduleHistoryEntryKey(entry: ScheduleHistoryEntry): string {
  switch (entry.type) {
    case "triggered":
    case "failed":
      return `${entry.type}:${entry.occurrenceId}`;
    case "skipped":
      return `${entry.type}:${entry.firstScheduledFor}:${entry.lastScheduledFor}:${entry.recordedAt}`;
  }
}

/** Keeps the actively rendered history window bounded while traversing toward older pages. */
export function prependOlderScheduleHistory(
  older: ReadonlyArray<ScheduleHistoryEntry>,
  current: ReadonlyArray<ScheduleHistoryEntry>,
  limit: number,
): ReadonlyArray<ScheduleHistoryEntry> {
  const seen = new Set<string>();
  const merged: ScheduleHistoryEntry[] = [];
  for (const entry of [...older, ...current]) {
    const key = scheduleHistoryEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
    if (merged.length === limit) break;
  }
  return merged;
}

export function mergeOlderScheduleHistory(input: {
  readonly currentOlder: readonly ScheduleHistoryEntry[];
  readonly page: readonly ScheduleHistoryEntry[];
  readonly recent: readonly ScheduleHistoryEntry[];
  readonly maximum: number;
}): readonly ScheduleHistoryEntry[] {
  const available = Math.max(0, input.maximum - input.recent.length);
  const recentKeys = new Set(input.recent.map(scheduleHistoryEntryKey));
  const seen = new Set<string>();
  const older = [...input.page, ...input.currentOlder].filter((entry) => {
    const key = scheduleHistoryEntryKey(entry);
    if (recentKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return available === 0 ? [] : older.slice(-available);
}
