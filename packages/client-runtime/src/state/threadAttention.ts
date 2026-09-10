import { QUEUED_TURN_START_GRACE_MS } from "./threadSettled.ts";
import type {
  OrchestrationLatestTurn,
  OrchestrationSessionStatus,
  ProviderInteractionMode,
} from "@t3tools/contracts";

export interface ThreadAttentionInput {
  readonly id: string;
  readonly environmentId: string;
  readonly spawnedByThreadId?: string | null | undefined;
  readonly session?: { readonly status: OrchestrationSessionStatus } | null | undefined;
  readonly latestTurn?:
    | Pick<OrchestrationLatestTurn, "state" | "completedAt" | "requestedAt">
    | null
    | undefined;
  readonly hasPendingTurnStart?: boolean | undefined;
  readonly latestReportAt?: string | null | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly awaitingParentReplySince?: string | null | undefined;
}

const keyFor = (thread: ThreadAttentionInput) => `${thread.environmentId}:${thread.id}`;
const timestamp = (value: string | null | undefined) => {
  const parsed = value == null ? 0 : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Completed results use the same read predicate in ranking and row emphasis. */
export function hasUnreadThreadCompletion(
  thread: Pick<ThreadAttentionInput, "latestTurn">,
  lastVisitedAt: string | null | undefined,
): boolean {
  return (
    thread.latestTurn?.state === "completed" &&
    timestamp(thread.latestTurn.completedAt) > timestamp(lastVisitedAt)
  );
}

/** Rank active work without using streaming activity as a sort timestamp.
 * The caller supplies its normal order; equal priorities retain that order.
 * Family context includes pinned and filtered-out active threads, so hiding a
 * child never turns its waiting parent into a new result for the human.
 */
export function sortThreadsByAttention<T extends ThreadAttentionInput>(
  orderedThreads: readonly T[],
  context: {
    readonly threads: readonly ThreadAttentionInput[];
    readonly now: string;
    readonly propagateDescendantRank?: boolean;
    readonly visibleThreadKeys?: ReadonlySet<string>;
    readonly lastVisitedAtByKey?: Readonly<Record<string, string>> | undefined;
  },
): T[] {
  const threads = new Map(
    [...context.threads, ...orderedThreads].map((thread) => [keyFor(thread), thread]),
  );
  const children = new Map<string, string[]>();
  for (const [key, thread] of threads) {
    const parentKey = `${thread.environmentId}:${thread.spawnedByThreadId}`;
    if (thread.spawnedByThreadId == null || parentKey === key || !threads.has(parentKey)) continue;
    const siblings = children.get(parentKey) ?? [];
    siblings.push(key);
    children.set(parentKey, siblings);
  }

  // Decisions, failures, unread results, autonomous work, then quiet history.
  type Summary = { rank: number; busy: boolean; completedAt: number };
  const summaries = new Map<string, Summary>();
  const visiting = new Set<string>();
  const summarize = (key: string): Summary => {
    const cached = summaries.get(key);
    if (cached) return cached;
    // Malformed parent cycles must neither recurse forever nor look complete.
    if (visiting.has(key)) return { rank: 3, busy: true, completedAt: 0 };
    visiting.add(key);
    const thread = threads.get(key)!;
    const status = thread.session?.status;
    const completedAt = timestamp(thread.latestTurn?.completedAt);
    const running = status === "running" || status === "starting";
    const failed = status === "error";
    const waiting = thread.awaitingParentReplySince != null && status !== "stopped";
    const messageAt = timestamp(thread.latestUserMessageAt);
    const queued =
      thread.hasPendingTurnStart === true ||
      (thread.hasPendingTurnStart === undefined &&
        !failed &&
        messageAt > Math.max(timestamp(thread.latestTurn?.requestedAt), completedAt) &&
        Math.abs(timestamp(context.now) - messageAt) <= QUEUED_TURN_START_GRACE_MS);
    const busy = running || waiting || queued || thread.backgroundLiveness != null;
    const descendants = (children.get(key) ?? []).map(summarize);
    const childBusy = descendants.some((child) => child.busy);
    const childCompletedAt = Math.max(0, ...descendants.map((child) => child.completedAt));
    const visibleDescendants = (children.get(key) ?? []).filter(
      (childKey) =>
        context.visibleThreadKeys === undefined ||
        (context.visibleThreadKeys.has(key) && context.visibleThreadKeys.has(childKey)),
    );
    const parentKey = `${thread.environmentId}:${thread.spawnedByThreadId}`;
    const hasParent =
      thread.spawnedByThreadId != null && parentKey !== key && threads.has(parentKey);
    const decision =
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      (thread.interactionMode === "plan" &&
        thread.hasActionableProposedPlan &&
        completedAt > 0 &&
        !running &&
        !failed &&
        !queued &&
        !waiting);
    const unread = hasUnreadThreadCompletion(thread, context.lastVisitedAtByKey?.[key]);
    // A child's completion belongs to its parent. A quiet parent is still
    // delegating while descendants run or have a newer result to hand back.
    const handoff = childBusy || childCompletedAt > completedAt;
    const ownRank = decision ? 0 : failed ? 1 : busy || handoff ? 3 : unread && !hasParent ? 2 : 4;
    const summary = {
      rank:
        context.propagateDescendantRank === false
          ? ownRank
          : Math.min(ownRank, ...visibleDescendants.map((childKey) => summarize(childKey).rank)),
      busy: busy || childBusy,
      // Reports can wake a parent before this child finishes its turn. Use
      // the current turn's report time rather than its later final response.
      completedAt: Math.max(
        timestamp(thread.latestReportAt) >= timestamp(thread.latestTurn?.requestedAt) &&
          thread.latestReportAt != null
          ? timestamp(thread.latestReportAt)
          : completedAt,
        childCompletedAt,
      ),
    };
    visiting.delete(key);
    summaries.set(key, summary);
    return summary;
  };
  for (const key of threads.keys()) summarize(key);
  return [...orderedThreads].sort(
    (left, right) =>
      (summaries.get(keyFor(left))?.rank ?? 4) - (summaries.get(keyFor(right))?.rank ?? 4),
  );
}
