import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadRowAccessibilityLabel,
  pendingTaskRowAccessibility,
  spokenWakeTime,
  truncateSpokenError,
} from "./thread-row-accessibility";

describe("buildThreadRowAccessibilityLabel", () => {
  const base = {
    title: "Fix login",
    hasQueuedMessages: false,
    identityLabel: "Ready, codex, gpt-5",
    failedError: null,
    snoozeWakeLabel: undefined,
  };

  it("reads title and identity for a plain row", () => {
    expect(buildThreadRowAccessibilityLabel(base)).toBe("Fix login. Ready, codex, gpt-5");
  });

  it("appends the failed error after the identity", () => {
    expect(
      buildThreadRowAccessibilityLabel({
        ...base,
        identityLabel: "Failed, codex, gpt-5",
        failedError: "  Provider exited\nwith code 1  ",
      }),
    ).toBe("Fix login. Failed, codex, gpt-5. Provider exited with code 1");
  });

  it("reads the wake countdown on snoozed rows", () => {
    expect(buildThreadRowAccessibilityLabel({ ...base, snoozeWakeLabel: "45m" })).toBe(
      "Fix login. Ready, codex, gpt-5. Wakes in 45 minutes",
    );
    expect(buildThreadRowAccessibilityLabel({ ...base, snoozeWakeLabel: "now" })).toBe(
      "Fix login. Ready, codex, gpt-5. Wakes now",
    );
  });

  it("keeps queued messages before the identity", () => {
    expect(buildThreadRowAccessibilityLabel({ ...base, hasQueuedMessages: true })).toBe(
      "Fix login. messages queued to send. Ready, codex, gpt-5",
    );
  });
});

describe("spokenWakeTime", () => {
  it("expands the row's compact units into words", () => {
    expect(spokenWakeTime("45m")).toBe("Wakes in 45 minutes");
    expect(spokenWakeTime("1m")).toBe("Wakes in 1 minute");
    expect(spokenWakeTime("2h")).toBe("Wakes in 2 hours");
    expect(spokenWakeTime("1h")).toBe("Wakes in 1 hour");
    expect(spokenWakeTime("3d")).toBe("Wakes in 3 days");
    expect(spokenWakeTime("now")).toBe("Wakes now");
  });

  it("passes an unfamiliar label through unchanged", () => {
    expect(spokenWakeTime("Tue 9:00")).toBe("Wakes in Tue 9:00");
  });
});

describe("truncateSpokenError", () => {
  it("cuts long errors at a word boundary with an ellipsis", () => {
    const error = `${"word ".repeat(40)}tail`;
    const spoken = truncateSpokenError(error);
    expect(spoken.length).toBeLessThanOrEqual(120);
    expect(spoken.endsWith("word…")).toBe(true);
  });

  it("hard-cuts a single long token instead of dropping most of it", () => {
    const spoken = truncateSpokenError("x".repeat(300));
    expect(spoken).toBe(`${"x".repeat(119)}…`);
    expect(spoken.length).toBe(120);
  });
});

describe("pendingTaskRowAccessibility", () => {
  it("announces drafts as drafts", () => {
    const draft = pendingTaskRowAccessibility({
      kind: "draft",
      title: "Add tests",
      projectTitle: "phoenix",
      environmentLabel: null,
    });
    expect(draft.label).toBe("Add tests, Draft, phoenix");
    expect(draft.deleteActionLabel).toBe("Discard draft");
    expect(draft.hint).toMatch(/composer/);
  });

  it("keeps queued wording for unsent sends", () => {
    const queued = pendingTaskRowAccessibility({
      kind: "pending",
      title: "Add tests",
      projectTitle: "phoenix",
      environmentLabel: "Laptop",
    });
    expect(queued.label).toBe("Add tests, Queued, phoenix, Laptop");
    expect(queued.deleteActionLabel).toBe("Delete queued task");
    expect(queued.hint).toMatch(/reconnects/);
  });
});
