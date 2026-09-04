/**
 * Sessions right-panel surface: the roster of threads this thread's agent
 * spawned through the `sessions` MCP toolkit, and the way back into any of
 * them.
 *
 * Visualization rules, shared with the Agents panel so the two read as one
 * system:
 * - Rows reserve three fixed lines (identity, activity, metadata); changing
 *   data must never change a row's height.
 * - One steady in-flight presentation. Starting, running, and live background
 *   work all read as Working; only attention and settled outcomes differ.
 * - Static status dots, no repainting animation.
 *
 * Unlike the Agents roster, every row here is a real thread, so every row is
 * a link — that is the whole point of the surface.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Boxes, ChevronRight, GitBranch } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useSpawnedThreadShells } from "~/state/threads";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "~/timestampFormat";

import type {
  SessionActivityState,
  SessionPanelEntry,
  SessionPanelModel,
} from "./SessionsPanel.logic";
import { buildSessionPanelModel, EXIT_REASON_LABELS } from "./SessionsPanel.logic";

const ACTIVITY_VISUALS: Record<SessionActivityState, { dotClass: string; label: string }> = {
  "needs-you": { dotClass: "bg-warning", label: "Needs you" },
  // The child asked and is blocked until this thread answers. Warning-toned
  // like needs-you: either way, the roster is pointing at a stalled child.
  "awaiting-reply": { dotClass: "bg-warning", label: "Awaiting reply" },
  working: { dotClass: "bg-info", label: "Working" },
  monitoring: { dotClass: "bg-info", label: "Monitoring" },
  stopping: { dotClass: "bg-muted-foreground/60", label: "Stopping" },
  // A resting child reads as settled rather than in-progress: a sky dot on an
  // idle session is the "lying spinner" the Agents panel already ruled out.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  stopped: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  error: { dotClass: "bg-destructive", label: "Error" },
  "not-started": { dotClass: "bg-muted-foreground/40", label: "Not started" },
};

/** Settled rows mute their dot: the outcome, not the last provider state, is
    what a history row is reporting. */
function dotClassFor(entry: SessionPanelEntry): string {
  if (entry.activity === "needs-you" || entry.activity === "error") {
    return ACTIVITY_VISUALS[entry.activity].dotClass;
  }
  if (entry.lifecycle === "settled") {
    return entry.activity === "stopping" ? ACTIVITY_VISUALS.stopping.dotClass : "bg-success";
  }
  return ACTIVITY_VISUALS[entry.activity].dotClass;
}

/**
 * Status-dependent activity line: live rows lead with what is happening now,
 * settled rows with how they ended. An error is the only inline preview on a
 * failed row, because it explains a red row at a glance.
 */
function activityText(entry: SessionPanelEntry): string {
  // A dead session leads with WHY it died — quota, crash, a stop — because
  // that decides what to do next (re-route vs retry vs nothing). The raw
  // provider error follows when there is one.
  if (entry.activity === "error" && entry.exitReason !== null) {
    const reason = EXIT_REASON_LABELS[entry.exitReason];
    return entry.lastError ? `${reason} · ${entry.lastError}` : reason;
  }
  if (entry.activity === "error" && entry.lastError) return entry.lastError;
  if (entry.lifecycle === "active") {
    if (entry.activity === "awaiting-reply" && entry.awaitingReplySince !== null) {
      return `Blocked · awaiting your reply for ${formatElapsedDurationLabel(entry.awaitingReplySince)}`;
    }
    if (entry.activity === "stopped" && entry.exitReason !== null) {
      return EXIT_REASON_LABELS[entry.exitReason];
    }
    return entry.planStep ?? ACTIVITY_VISUALS[entry.activity].label;
  }
  // A reclaimed worktree is the thing to say about a settled session: without
  // one it cannot be resumed, which is worth knowing before trying.
  return entry.worktreePath === null
    ? "Settled · worktree reclaimed"
    : `Settled · ${ACTIVITY_VISUALS[entry.activity].label.toLocaleLowerCase()}`;
}

function branchLabel(branch: string): string {
  // Worktree branches are long and front-loaded with a shared prefix; the
  // tail is the part that identifies the child.
  return branch.length <= 28 ? branch : `…${branch.slice(-27)}`;
}

const SessionRow = memo(function SessionRow({
  entry,
  onOpen,
}: {
  entry: SessionPanelEntry;
  onOpen: (threadId: string) => void;
}) {
  const visuals = ACTIVITY_VISUALS[entry.activity];
  const metadata = [
    entry.model,
    entry.providerInstanceId !== null && entry.providerInstanceId !== entry.model
      ? entry.providerInstanceId
      : null,
    entry.sessionStatus,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.threadId)}
      aria-label={`Open session: ${entry.title}`}
      className="group grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left transition hover:bg-accent/50"
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClassFor(entry))} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
        {entry.lifecycle !== "active" ? (
          <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {entry.lifecycle}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 flex min-w-14 items-center justify-end gap-1 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="tabular-nums">{formatRelativeTimeLabel(entry.lastActivityAt)}</span>
        <ChevronRight
          aria-hidden
          className="size-3 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          entry.activity === "error"
            ? "text-destructive-foreground"
            : entry.activity === "needs-you" || entry.activity === "awaiting-reply"
              ? "text-warning-foreground"
              : "text-muted-foreground",
        )}
      >
        {activityText(entry)}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 flex min-w-0 items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/70">
        <span className="min-w-0 truncate">{metadata.join(" · ")}</span>
        {entry.branch ? (
          <>
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{branchLabel(entry.branch)}</span>
          </>
        ) : null}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </button>
  );
});

function SessionSection({
  title,
  count,
  entries,
  onOpen,
}: {
  title: string;
  count: string;
  entries: ReadonlyArray<SessionPanelEntry>;
  onOpen: (threadId: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 px-1.5 pt-1 pb-0.5 text-[.65rem] font-medium tracking-wider text-muted-foreground uppercase">
        <span>{title}</span>
        <span className="font-normal text-muted-foreground/70 normal-case">{count}</span>
      </div>
      {entries.map((entry) => (
        <SessionRow key={entry.threadId} entry={entry} onOpen={onOpen} />
      ))}
    </section>
  );
}

/**
 * Subscribes to the roster only while the surface is mounted. ChatView must
 * not hold this subscription itself: child shells change identity on every
 * provider update, which would repaint the app's largest component at the
 * children's streaming cadence even with this panel closed.
 */
export function SessionsPanelSurface({
  threadRef,
  onOpenThread,
}: {
  threadRef: ScopedThreadRef | null;
  onOpenThread: (threadId: string) => void;
}) {
  const shells = useSpawnedThreadShells(threadRef);
  const model = useMemo(() => buildSessionPanelModel(shells), [shells]);
  return <SessionsPanel model={model} onOpenThread={onOpenThread} />;
}

export function SessionsPanel({
  model,
  onOpenThread,
}: {
  model: SessionPanelModel;
  onOpenThread: (threadId: string) => void;
}) {
  if (model.total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Boxes aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No sessions yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns its own sessions, they show up here with live status and a way
          back into each one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          <SessionSection
            title="Active"
            count={`${model.activeCount}`}
            entries={model.active}
            onOpen={onOpenThread}
          />
          <SessionSection
            title="Settled"
            count={`${model.settledCount}`}
            entries={model.settled}
            onOpen={onOpenThread}
          />
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.needsAttentionCount > 0 ? (
            <span className="text-warning-foreground">● {model.needsAttentionCount} needs you</span>
          ) : null}
          {model.awaitingReplyCount > 0 ? (
            <span className="text-warning-foreground">
              ● {model.awaitingReplyCount} awaiting reply
            </span>
          ) : null}
          {model.workingCount > 0 ? (
            <span className="text-info-foreground">● {model.workingCount} working</span>
          ) : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">
          {model.total} session{model.total === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
}
