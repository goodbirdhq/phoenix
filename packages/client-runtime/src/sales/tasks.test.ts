import type { SalesTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupTasks, inviteBudgetLine, taskActionLabel, taskDueLabel } from "./tasks.ts";

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
    expect(groups.upcoming.map((item) => item.id)).toEqual(["b"]);
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
