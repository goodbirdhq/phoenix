import {
  SALES_TASK_OUTCOMES,
  type SalesTask,
  type SalesTaskBudget,
  type SalesTaskList,
  type SalesTaskOutcome,
  type SalesTaskReport,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import { readSalesFailure } from "./failure.ts";
import { salesDay } from "./time.ts";

/** What to do on LinkedIn, as the checklist names it. */
export function taskActionLabel(action: string): string {
  switch (action) {
    case "connect":
      return "Connect";
    case "dm":
      return "Message";
    default:
      return "LinkedIn task";
  }
}

/** Where the connection stands, when it is known. */
export function connectionLabel(state: string): string | null {
  switch (state) {
    case "pending":
      return "Request pending";
    case "connected":
      return "Connected";
    default:
      return null;
  }
}

/** When a task falls due against the engine's today; both are `YYYY-MM-DD`. */
export function taskDueLabel(dueOn: string | null, today: string | null): string | null {
  if (dueOn === null) return null;
  if (today === null) return `Due ${salesDay(dueOn)}`;
  if (dueOn === today) return "Due today";
  return dueOn < today ? `Overdue since ${salesDay(dueOn)}` : `Due ${salesDay(dueOn)}`;
}

export interface SalesTaskGroups {
  /** Posted to Slack, ready to do. */
  readonly ready: ReadonlyArray<SalesTask>;
  /**
   * Not posted yet: a backlog the engine posts as the invite budget allows. Not the person's work
   * yet, so never overdue.
   */
  readonly waiting: ReadonlyArray<SalesTask>;
}

/** The checklist's two parts, each in the engine's order. */
export function groupTasks(items: ReadonlyArray<SalesTask>): SalesTaskGroups {
  return {
    ready: items.filter((task) => task.status === "posted"),
    waiting: items.filter((task) => task.status !== "posted"),
  };
}

/** `1 of 7 invites left today`, or null when the engine gave no budget. */
export function inviteBudgetLine(budget: SalesTaskBudget): string | null {
  if (budget.available === null || budget.dailyLimit === null) return null;
  return `${budget.available} of ${budget.dailyLimit} invites left today`;
}

/** The outcomes that report something sent; a connection request needs a budget place for them. */
const SENDS = new Set<SalesTaskOutcome>(["request_sent", "connected_message", "pending_message"]);

const OUTCOME_LABELS: Record<SalesTaskOutcome, string> = {
  request_sent: "Mark as sent",
  pending: "Already pending",
  connected: "Already connected",
  connected_message: "Connected, sent a message",
  pending_message: "Pending, sent a message",
  skip: "Skip",
};

export const taskOutcomeLabel = (outcome: SalesTaskOutcome) => OUTCOME_LABELS[outcome];

/**
 * "Mark as sent" with the contact's first name (`Mark sent to Ana`): one click spends an invite
 * for good, so the button says whose it is.
 */
export function markSentLabel(task: Pick<SalesTask, "contact">): string {
  const [first] = task.contact.name?.trim().split(/\s+/) ?? [];
  return first ? `Mark sent to ${first}` : OUTCOME_LABELS.request_sent;
}

/** The engine's list for an action, by a name this build may not know. */
function listedOutcomes(action: string): ReadonlyArray<SalesTaskOutcome> {
  const byAction: Readonly<Record<string, ReadonlyArray<SalesTaskOutcome>>> = SALES_TASK_OUTCOMES;
  return Object.hasOwn(byAction, action) ? (byAction[action] ?? []) : [];
}

/**
 * What a task offers to report, from the engine's one list (`SALES_TASK_OUTCOMES`), less what the
 * engine would refuse: a connection request with no place in the budget can't be reported sent
 * (`not_admitted`). `primary` is `request_sent` where it is offered (its button is
 * `markSentLabel`'s); the rest go in `others`.
 */
export function taskOutcomeChoices(task: Pick<SalesTask, "action" | "admittedOn">): {
  readonly primary: SalesTaskOutcome | null;
  readonly others: ReadonlyArray<SalesTaskOutcome>;
} {
  const offered = listedOutcomes(task.action).filter(
    (outcome) => !(task.action === "connect" && task.admittedOn === null && SENDS.has(outcome)),
  );
  const primary = offered.includes("request_sent") ? "request_sent" : null;
  return { primary, others: offered.filter((outcome) => outcome !== primary) };
}

const RECORDED: Record<SalesTaskOutcome, string> = {
  request_sent: "Marked as sent",
  pending: "Recorded: request pending",
  connected: "Recorded: connected",
  connected_message: "Recorded: connected, message sent",
  pending_message: "Recorded: pending, message sent",
  skip: "Skipped",
};

export interface SalesTaskReportOutcome {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
  /** Today's invite budget after the report, when the engine answered. */
  readonly budget: SalesTaskBudget | null;
}

/** What a report did, told as the engine answered it; nothing is assumed before it answers. */
export function taskReportOutcome(
  outcome: SalesTaskOutcome,
  result: AtomCommandResult<SalesTaskReport, unknown>,
): SalesTaskReportOutcome {
  if (result._tag !== "Success") {
    const failure = readSalesFailure(result);
    const text =
      failure.reason === "not_found"
        ? { title: "The engine has no such task", description: "It may be done already." }
        : failure.reason === "not_open"
          ? {
              title: "Already reported",
              description: "It was decided already as something else.",
            }
          : failure;
    return { tone: "error", title: text.title, description: text.description, budget: null };
  }
  const { result: what, reason, budget } = result.value;
  const answer = (tone: SalesTaskReportOutcome["tone"], title: string, description = "") => ({
    tone,
    title,
    description,
    budget,
  });
  switch (what) {
    case "recorded":
      return answer("success", RECORDED[outcome]);
    case "already":
      return answer("success", "Already recorded", "Nothing changed.");
    case "held":
      return answer(
        "warning",
        "Not recorded yet",
        `${reason ?? "The engine's check could not clear it now."} It stays open to report again.`,
      );
    case "skipped":
      return answer("warning", "Skipped instead", reason ?? "The engine's check ruled them out.");
    case "backlog_paused":
      return answer("warning", "Not recorded", "Backlog tasks are paused in the engine.");
    default:
      return answer("warning", "The engine answered something new", `It said “${what}”.`);
  }
}

/**
 * The budget to show: one a report returned, until a newer list arrives (`listGeneratedAt`
 * moves on), then the list's.
 */
export function shownBudget(
  list: Pick<SalesTaskList, "generatedAt" | "budget">,
  reported: { readonly budget: SalesTaskBudget; readonly listGeneratedAt: string } | null,
): SalesTaskBudget {
  return reported !== null && reported.listGeneratedAt === list.generatedAt
    ? reported.budget
    : list.budget;
}
