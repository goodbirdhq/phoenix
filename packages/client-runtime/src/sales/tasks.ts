import type { SalesTask, SalesTaskList } from "@t3tools/contracts";

import { salesDay } from "./time.ts";

/** What to do on LinkedIn, as the checklist names it. */
export function taskActionLabel(action: string): string {
  switch (action) {
    case "connect":
      return "Connect";
    case "dm":
      return "Message";
    default:
      return action.length > 0 ? action[0]!.toUpperCase() + action.slice(1) : "Task";
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
  /** On a Slack card, ready to do. */
  readonly ready: ReadonlyArray<SalesTask>;
  /** Not on a card yet; the engine posts them as the budget allows. */
  readonly upcoming: ReadonlyArray<SalesTask>;
}

/** The checklist's two parts, each in the engine's order. */
export function groupTasks(items: ReadonlyArray<SalesTask>): SalesTaskGroups {
  return {
    ready: items.filter((task) => task.status === "posted"),
    upcoming: items.filter((task) => task.status !== "posted"),
  };
}

/** `1 of 7 invites left today`, or null when the engine gave no budget. */
export function inviteBudgetLine(budget: SalesTaskList["budget"]): string | null {
  if (budget.available === null || budget.dailyLimit === null) return null;
  return `${budget.available} of ${budget.dailyLimit} invites left today`;
}
