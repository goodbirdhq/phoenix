import { describe, expect, it } from "@effect/vitest";

import { resolveThreadAgentGroupPress } from "./thread-agent-group-disclosure";

describe("thread agent group disclosure", () => {
  it("toggles the visible child hierarchy when a child can be disclosed", () => {
    expect(resolveThreadAgentGroupPress(true)).toBe("toggle");
  });

  it("opens session details when all children are already pinned", () => {
    expect(resolveThreadAgentGroupPress(false)).toBe("details");
  });
});
