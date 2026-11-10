import { SalesActionError, type SalesTask, type SalesTaskReport } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  groupTasks,
  inviteBudgetLine,
  markSentLabel,
  shownBudget,
  taskActionLabel,
  taskDueLabel,
  taskOutcomeChoices,
  taskReportOutcome,
} from "./tasks.ts";

describe("tasks", () => {
  it("reads due days against the engine's today", () => {
    expect(taskDueLabel("2026-11-09", "2026-11-09")).toBe("Due today");
    expect(taskDueLabel("2026-11-05", "2026-11-09")).toMatch(/^Overdue since /);
    expect(taskDueLabel("2026-11-12", "2026-11-09")).toMatch(/^Due /);
    expect(taskDueLabel(null, "2026-11-09")).toBeNull();
  });

  it("splits tasks posted to Slack from those not posted yet", () => {
    const task = (id: string, status: string) => ({ id, status }) as SalesTask;
    const groups = groupTasks([task("a", "posted"), task("b", "pending"), task("c", "posted")]);
    expect(groups.ready.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups.waiting.map((item) => item.id)).toEqual(["b"]);
  });

  it("names an action it does not know without the engine's word for it", () => {
    expect(taskActionLabel("dm")).toBe("Message");
    expect(taskActionLabel("endorse_skill")).toBe("LinkedIn task");
  });

  it("says the invite budget only when the engine gives one", () => {
    expect(inviteBudgetLine({ day: null, dailyLimit: 7, available: 1 })).toBe(
      "1 of 7 invites left today",
    );
    expect(inviteBudgetLine({ day: null, dailyLimit: null, available: null })).toBeNull();
  });
});

describe("task outcomes", () => {
  it("offers what the engine lists for each action, Mark as sent first", () => {
    expect(taskOutcomeChoices({ action: "connect", admittedOn: "2026-11-09" })).toEqual({
      primary: "request_sent",
      others: ["pending", "connected", "skip", "connected_message", "pending_message"],
    });
    expect(taskOutcomeChoices({ action: "dm", admittedOn: null })).toEqual({
      primary: "request_sent",
      others: ["skip"],
    });
    for (const action of ["endorse_skill", "toString"]) {
      expect(taskOutcomeChoices({ action, admittedOn: null })).toEqual({
        primary: null,
        others: [],
      });
    }
  });

  it("names whose invite Mark as sent spends", () => {
    const task = (name: string | null) => ({ contact: { name } }) as Pick<SalesTask, "contact">;
    expect(markSentLabel(task("Ana de la Cruz"))).toBe("Mark sent to Ana");
    expect(markSentLabel(task(null))).toBe("Mark as sent");
    expect(markSentLabel(task("  "))).toBe("Mark as sent");
  });

  it("offers no send on a connection request without a place in the budget", () => {
    expect(taskOutcomeChoices({ action: "connect", admittedOn: null })).toEqual({
      primary: null,
      others: ["pending", "connected", "skip"],
    });
  });

  const budget = { day: "2026-11-09", dailyLimit: 7, available: 0 };
  const answer = (result: string, reason: string | null = null) =>
    AsyncResult.success<SalesTaskReport>({
      result,
      reason,
      task: { id: "t1", action: "connect", status: "done", outcome: null, connectionState: null },
      budget,
    });

  it("tells what the engine answered, and carries its budget", () => {
    expect(taskReportOutcome("request_sent", answer("recorded"))).toEqual({
      tone: "success",
      title: "Marked as sent",
      description: "",
      budget,
    });
    expect(taskReportOutcome("skip", answer("held", "Their Contact is suppressed."))).toMatchObject(
      {
        tone: "warning",
        title: "Not recorded yet",
        description: "Their Contact is suppressed. It stays open to report again.",
      },
    );
    expect(taskReportOutcome("pending", answer("skipped", "Bounced."))).toMatchObject({
      title: "Skipped instead",
      description: "Bounced.",
    });
    expect(taskReportOutcome("pending", answer("a_later_result")).tone).toBe("warning");
  });

  it("says why a report was refused, with no budget to show", () => {
    const refused: AtomCommandResult<SalesTaskReport, unknown> = AsyncResult.failure(
      Cause.fail(
        new SalesActionError({
          origin: "engine",
          reason: "not_admitted",
          message: "No place.",
          currentHash: null,
          state: "pending",
        }),
      ),
    );
    expect(taskReportOutcome("request_sent", refused)).toMatchObject({
      tone: "error",
      title: "No invite place for this request yet",
      budget: null,
    });
  });

  it("shows a reported budget until a newer list arrives", () => {
    const list = { generatedAt: "t1", budget: { day: null, dailyLimit: 7, available: 2 } };
    const reported = { budget, listGeneratedAt: "t1" };
    expect(shownBudget(list, reported)).toBe(budget);
    expect(shownBudget({ ...list, generatedAt: "t2" }, reported)).toBe(list.budget);
    expect(shownBudget(list, null)).toBe(list.budget);
  });
});
