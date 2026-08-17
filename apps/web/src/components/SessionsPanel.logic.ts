/**
 * Model for the Sessions right-panel surface: the roster of threads this
 * thread's agent spawned through the `sessions` MCP toolkit.
 *
 * The lifecycle vocabulary is deliberately the toolkit's own (see
 * `ListSessionsInput` in contracts/sessionOrchestration) so the panel and the
 * agent driving it never disagree about what "settled" means: a child is
 * active until `settledAt` is stamped, and settled after. Archiving is not a
 * third state here — an archived thread leaves the shell snapshot entirely,
 * so it leaves this roster too. Everything else on a row is presentation
 * derived from the same thread shell the sidebar renders — no extra fetch, no
 * extra contract.
 */
import { isActiveSpawnedSession } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationSessionStatus, OrchestrationThreadShell } from "@t3tools/contracts";

export type SessionLifecycle = "active" | "settled";

/**
 * One steady in-flight presentation, matching the Agents panel: a child that
 * is starting, running, or carrying live background work all read as
 * "working". Only attention and settled outcomes differentiate.
 */
export type SessionActivityState =
  | "needs-you"
  | "working"
  | "monitoring"
  | "stopping"
  | "idle"
  | "stopped"
  | "error"
  | "not-started";

export interface SessionPanelEntry {
  readonly threadId: string;
  readonly title: string;
  readonly lifecycle: SessionLifecycle;
  readonly activity: SessionActivityState;
  /** Raw provider session status, shown as the row's monospace detail. */
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly model: string;
  readonly providerInstanceId: string | null;
  readonly branch: string | null;
  /** Null once settle/archive reclaimed the worktree — the child can no
      longer be resumed, which is worth showing before a user tries. */
  readonly worktreePath: string | null;
  /** Current plan step while a turn runs. Cleared when the turn settles. */
  readonly planStep: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  /** Newest of the signals a row's elapsed/`ago` column can key off. */
  readonly lastActivityAt: string;
}

export interface SessionPanelModel {
  readonly active: ReadonlyArray<SessionPanelEntry>;
  readonly settled: ReadonlyArray<SessionPanelEntry>;
  readonly total: number;
  readonly activeCount: number;
  readonly workingCount: number;
  readonly needsAttentionCount: number;
  readonly settledCount: number;
}

export const EMPTY_SESSION_PANEL_MODEL: SessionPanelModel = {
  active: [],
  settled: [],
  total: 0,
  activeCount: 0,
  workingCount: 0,
  needsAttentionCount: 0,
  settledCount: 0,
};

function lifecycleOf(shell: OrchestrationThreadShell): SessionLifecycle {
  return isActiveSpawnedSession(shell) ? "active" : "settled";
}

/**
 * Attention outranks work, and work outranks a resting status: a child
 * blocked on an approval is the one thing in this list a user must act on, so
 * it can never be presented as merely "working".
 */
function activityOf(
  shell: OrchestrationThreadShell,
  lifecycle: SessionLifecycle,
): SessionActivityState {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needs-you";
  const status = shell.session?.status ?? null;
  const running = status === "starting" || status === "running";
  // A settled child is history, so it never reads as working — but settling
  // can fail to stop the process in time, and a row claiming "idle" while the
  // provider is still burning tokens would be a lie. Call that winding down.
  if (lifecycle === "settled") {
    if (running) return "stopping";
  } else {
    if (running) return "working";
    // Liveness only counts while the child is in play: a settled child's stale
    // flag would spin in the roster forever.
    if (shell.backgroundLiveness != null) {
      return shell.backgroundLiveness === "monitoring" ? "monitoring" : "working";
    }
  }
  if (status === "error") return "error";
  if (status === "stopped" || status === "interrupted") return "stopped";
  if (status === "ready" || status === "idle") return "idle";
  return "not-started";
}

/** Newest timestamp the row can honestly call "last activity". */
function lastActivityAt(shell: OrchestrationThreadShell): string {
  const candidates = [
    shell.session?.updatedAt,
    shell.latestTurn?.completedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.requestedAt,
    shell.latestUserMessageAt,
    shell.updatedAt,
    shell.createdAt,
  ];
  let newest = shell.createdAt;
  let newestMs = Date.parse(shell.createdAt);
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    // A malformed timestamp must not win by producing NaN comparisons.
    if (Number.isNaN(parsed) || parsed <= newestMs) continue;
    newest = candidate;
    newestMs = parsed;
  }
  return newest;
}

function toEntry(shell: OrchestrationThreadShell): SessionPanelEntry {
  const lifecycle = lifecycleOf(shell);
  return {
    threadId: shell.id,
    title: shell.title,
    lifecycle,
    activity: activityOf(shell, lifecycle),
    sessionStatus: shell.session?.status ?? null,
    model: shell.modelSelection.model,
    providerInstanceId: shell.modelSelection.instanceId ?? null,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    planStep: shell.planProgress?.step ?? null,
    lastError: shell.session?.lastError ?? null,
    createdAt: shell.createdAt,
    lastActivityAt: lastActivityAt(shell),
  };
}

function byCreatedAtDescending(left: SessionPanelEntry, right: SessionPanelEntry): number {
  const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  // Stable tiebreak: sessions spawned in the same millisecond (a fan-out
  // does exactly this) must not reshuffle between renders.
  return Number.isNaN(delta) || delta === 0 ? left.threadId.localeCompare(right.threadId) : delta;
}

/**
 * Splits a parent's children into the two sections the panel renders. Active
 * children lead (they are the ones still costing something), settled history
 * follows, both newest first. Deleted and archived threads never reach the
 * shell snapshot, so nothing filters them here.
 */
export function buildSessionPanelModel(
  children: ReadonlyArray<OrchestrationThreadShell>,
): SessionPanelModel {
  if (children.length === 0) return EMPTY_SESSION_PANEL_MODEL;

  const active: SessionPanelEntry[] = [];
  const settled: SessionPanelEntry[] = [];
  let workingCount = 0;
  let needsAttentionCount = 0;

  for (const shell of children) {
    const entry = toEntry(shell);
    if (entry.activity === "needs-you") needsAttentionCount += 1;
    if (entry.activity === "working" || entry.activity === "monitoring") workingCount += 1;
    if (entry.lifecycle === "active") active.push(entry);
    else settled.push(entry);
  }

  active.sort(byCreatedAtDescending);
  settled.sort(byCreatedAtDescending);

  return {
    active,
    settled,
    total: active.length + settled.length,
    activeCount: active.length,
    workingCount,
    needsAttentionCount,
    settledCount: settled.length,
  };
}
