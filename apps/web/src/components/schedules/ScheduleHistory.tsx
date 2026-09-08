import type {
  EnvironmentId,
  ScheduleDetail,
  ScheduleHistoryCursor,
  ScheduleHistoryEntry,
  ThreadId,
} from "@t3tools/contracts";
import { formatScheduleTimestamp } from "@t3tools/client-runtime/schedules";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { scheduleEnvironment } from "../../state/schedules";
import { Button } from "../ui/button";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "../ui/table";
import { prependOlderScheduleHistory, scheduleHistoryEntryKey } from "./SchedulesPage.logic";

export function ScheduleHistoryTable({
  entries,
  timeZone,
  onOpenThread,
  compact = false,
}: {
  entries: readonly ScheduleHistoryEntry[];
  timeZone: string;
  onOpenThread: (id: ThreadId) => void;
  compact?: boolean;
}) {
  if (!entries.length)
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No occurrences yet. History appears after the first trigger.
      </p>
    );
  return (
    <Table className="schedule-history">
      <colgroup>
        <col style={{ width: compact ? "auto" : "220px" }} />
        <col style={{ width: "130px" }} />
        {!compact && <col />}
        <col style={{ width: "140px" }} />
      </colgroup>
      {!compact && (
        <TableHeader>
          <TableRow>
            <TableHead>Scheduled for</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Details</TableHead>
            <TableHead className="text-right">Thread</TableHead>
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {entries.toReversed().map((entry) => (
          <TableRow key={scheduleHistoryEntryKey(entry)}>
            <TableCell>
              {formatScheduleTimestamp(
                entry.type === "skipped"
                  ? entry.firstScheduledFor
                  : entry.type === "failed"
                    ? entry.scheduledFor
                    : entry.scheduledFor,
                timeZone,
              )}
            </TableCell>
            <TableCell>
              <span
                className={
                  entry.type === "failed"
                    ? "text-destructive"
                    : entry.type === "triggered"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground"
                }
              >
                {entry.type === "triggered"
                  ? "Triggered"
                  : entry.type === "failed"
                    ? "Failed"
                    : "Skipped"}
              </span>
            </TableCell>
            {!compact && (
              <TableCell className="pr-4">
                {entry.type === "triggered"
                  ? `Started ${formatScheduleTimestamp(entry.triggeredAt, timeZone)}`
                  : entry.type === "failed"
                    ? `${entry.message} · ${entry.count} ${entry.count === 1 ? "attempt" : "attempts"}`
                    : `${entry.countIsLowerBound ? "At least " : ""}${entry.count.toLocaleString()} older occurrences · through ${formatScheduleTimestamp(entry.lastScheduledFor, timeZone)}`}
              </TableCell>
            )}
            <TableCell className="text-right">
              {entry.type === "triggered" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-0 text-[13px]"
                  onClick={() => onOpenThread(entry.threadId)}
                >
                  Open thread →
                </Button>
              ) : (
                <span aria-label="No thread">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ScheduleHistory({
  detail,
  environmentId,
  online,
  timeZone,
  onOpenThread,
}: {
  detail: ScheduleDetail;
  environmentId: EnvironmentId;
  online: boolean;
  timeZone: string;
  onOpenThread: (id: ThreadId) => void;
}) {
  const [entries, setEntries] = useState<readonly ScheduleHistoryEntry[]>(detail.history);
  const [cursor, setCursor] = useState<ScheduleHistoryCursor | null>(detail.historyNextCursor);
  const [requested, setRequested] = useState<ScheduleHistoryCursor | null>(null);
  const [older, setOlder] = useState(false);
  useEffect(() => {
    if (older || requested !== null) return;
    setEntries(detail.history);
    setCursor(detail.historyNextCursor);
  }, [detail.history, detail.historyNextCursor, older, requested]);
  const history = useEnvironmentQuery(
    requested === null
      ? null
      : scheduleEnvironment.history({
          environmentId,
          input: { scheduleId: detail.id, cursor: requested, limit: 50 },
        }),
  );
  useEffect(() => {
    if (!requested || !history.data || history.data.scheduleId !== detail.id) return;
    setEntries((current) => prependOlderScheduleHistory(history.data!.entries, current, 200));
    setCursor(history.data.nextCursor);
    setOlder(true);
    setRequested(null);
  }, [requested, history.data, detail.id]);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Occurrence history</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {timeZone} · Newest first · Triggered means the thread accepted its first turn.
        </p>
      </div>
      <ScheduleHistoryTable entries={entries} timeZone={timeZone} onOpenThread={onOpenThread} />
      {history.error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          {history.error}
          <Button variant="outline" size="sm" onClick={history.refresh}>
            Try again
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {cursor && (
          <Button
            variant="outline"
            className="schedule-control"
            disabled={!online || requested !== null}
            onClick={() => setRequested(cursor)}
          >
            {requested ? "Loading…" : "Load older"}
          </Button>
        )}
        {older && (
          <Button
            variant="outline"
            className="schedule-control"
            onClick={() => {
              setEntries(detail.history);
              setCursor(detail.historyNextCursor);
              setRequested(null);
              setOlder(false);
            }}
          >
            Back to recent
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {online
            ? "Thread results, approvals and provider errors live in the thread."
            : "Unavailable while offline. Cached entries remain readable."}
        </p>
      </div>
    </div>
  );
}
