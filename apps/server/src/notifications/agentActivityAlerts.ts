import type {
  AgentActivityAggregateRow,
  AgentActivityAggregateState,
  AgentAwarenessPreferences,
} from "@t3tools/contracts/notifications";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

export function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

type TransitionInput = {
  readonly previousAggregate: AgentActivityAggregateState | null;
  readonly nextAggregate: AgentActivityAggregateState;
  readonly preferences: AgentAwarenessPreferences | null;
};

function rowKey(row: AgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

export function alertAllowedForPhase(
  preferences: AgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase),
  );
}

// Reconciliation uses only observed transitions. Event-driven delivery can
// include fresh completions whose running update never reached the device.
export function newlyTerminalRows(
  previousAggregate: AgentActivityAggregateState | null,
  nextAggregate: AgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<AgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return (
      alertAllowedForPhase(input.preferences, row.phase) &&
      isFreshTerminalNotification(row.updatedAt, input.nowMs)
    );
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<AgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: AgentActivityAggregateState | null;
  readonly preferences: AgentAwarenessPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(input.preferences, row.phase) ? alertForActivityRows([row]) : null;
}

export function shouldAlertForActivity(input: {
  readonly phase: AgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: AgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}
