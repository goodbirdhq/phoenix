import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadAvatarStatus,
  threadAvatarHasStatusBadge,
  threadIdentityLabel,
} from "./thread-avatar-status";

const resting = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: null,
  blockedOnThreadWait: false,
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
} as const;

describe("thread avatar status", () => {
  it("lets the snoozed shelf outrank runtime state", () => {
    expect(
      resolveThreadAvatarStatus({ ...resting, hasPendingApprovals: true }, { snoozed: true }),
    ).toBe("snoozed");
    expect(
      resolveThreadAvatarStatus({ ...resting, hasPendingApprovals: true }, { snoozed: false }),
    ).toBe("approval");
  });

  it("badges only states that ask for a glance", () => {
    expect(threadAvatarHasStatusBadge("working")).toBe(false);
    expect(threadAvatarHasStatusBadge("ready")).toBe(false);
    expect(threadAvatarHasStatusBadge("input")).toBe(true);
    expect(threadAvatarHasStatusBadge("failed")).toBe(true);
  });

  it("speaks status, provider and model, skipping a missing provider", () => {
    expect(
      threadIdentityLabel(
        { ...resting, hasPendingUserInput: true },
        {
          snoozed: false,
          providerName: "Codex",
        },
      ),
    ).toBe("Awaiting input, Codex, gpt-5.5");
    expect(threadIdentityLabel(resting, { snoozed: false, providerName: null })).toBe(
      "Ready, gpt-5.5",
    );
  });
});
