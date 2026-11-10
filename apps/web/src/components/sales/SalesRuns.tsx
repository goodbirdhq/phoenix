import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SALES_RUN_STATUS_LABELS,
  type SalesRunStatus,
  salesRunSettled,
  salesRunStatus,
} from "@t3tools/client-runtime/sales/runs";
import type { EnvironmentId, SalesDispatch, SalesDispatchSource } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useThreadShell } from "../../state/entities";
import { useDispatchedThreads } from "../../state/sales";
import { Badge } from "../ui/badge";

const STATUS_VARIANT: Record<
  SalesRunStatus,
  "info" | "warning" | "error" | "secondary" | "success"
> = {
  starting: "info",
  running: "info",
  waiting: "warning",
  failed: "error",
  stopped: "secondary",
  finished: "success",
};

/**
 * The runs started from some cards or conversations, each with its live status from the thread's
 * shell. `onSettled` fires once when a run watched here comes to rest, so the source can be read
 * again for what the run wrote.
 */
export function SalesRuns(props: {
  readonly environmentId: EnvironmentId;
  /** Memoized by the caller: a new array reads the runs again. */
  readonly sources: ReadonlyArray<SalesDispatchSource>;
  readonly onSettled?: () => void;
}) {
  const runs = useDispatchedThreads(props.environmentId, props.sources);
  if (runs.length === 0) return null;
  return (
    <section aria-label="Runs" className="grid gap-1.5">
      <h3 className="text-xs text-muted-foreground">Runs</h3>
      <ul className="grid gap-1">
        {runs.map((run) => (
          <SalesRunRow
            key={run.threadId}
            environmentId={props.environmentId}
            run={run}
            onSettled={props.onSettled}
          />
        ))}
      </ul>
    </section>
  );
}

function SalesRunRow(props: {
  readonly environmentId: EnvironmentId;
  readonly run: SalesDispatch;
  readonly onSettled: (() => void) | undefined;
}) {
  const { environmentId, run, onSettled } = props;
  const status = salesRunStatus(useThreadShell(scopeThreadRef(environmentId, run.threadId)));
  const previous = useRef<SalesRunStatus | undefined>(undefined);
  useEffect(() => {
    if (salesRunSettled(previous.current, status)) onSettled?.();
    previous.current = status;
  }, [status, onSettled]);

  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: run.threadId }}
        className="min-w-0 flex-1 truncate hover:underline"
      >
        {run.title}
      </Link>
      <Badge size="sm" variant={STATUS_VARIANT[status]}>
        {SALES_RUN_STATUS_LABELS[status]}
      </Badge>
    </li>
  );
}
