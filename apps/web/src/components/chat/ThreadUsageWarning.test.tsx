import { describe, expect, it } from "vite-plus/test";

import { resolveThreadUsageWarningInstanceId } from "./ThreadUsageWarning";

describe("resolveThreadUsageWarningInstanceId", () => {
  it("uses the session-bound account instead of an unsaved picker choice", () => {
    const chatState = {
      sessionProviderInstanceId: "claude_bound",
      threadModelSelectionInstanceId: "claude_saved",
      selectedProviderInstanceId: "claude_picker",
    };
    const instanceId = resolveThreadUsageWarningInstanceId(chatState);

    expect(instanceId).toBe("claude_bound");
    expect(instanceId).not.toBe(chatState.selectedProviderInstanceId);
  });

  it("falls back to the thread's saved model selection before a session exists", () => {
    expect(
      resolveThreadUsageWarningInstanceId({
        sessionProviderInstanceId: null,
        threadModelSelectionInstanceId: "codex_saved",
      }),
    ).toBe("codex_saved");
  });
});
