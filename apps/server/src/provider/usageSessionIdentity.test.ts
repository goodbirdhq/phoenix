import { describe, expect, it } from "@effect/vitest";
import { usageSessionIdentity } from "./usageSessionIdentity.ts";

describe("native usage session identity", () => {
  it("distinguishes the Phoenix thread id from Claude's native resume id", () => {
    expect(usageSessionIdentity("claudeAgent", { threadId: "phoenix", resume: "native" })).toBe(
      "native",
    );
    expect(usageSessionIdentity("claudeAgent", { threadId: "phoenix" })).toBeNull();
    expect(usageSessionIdentity("codex", { threadId: "native" })).toBe("native");
  });
  it("accepts supported ACP cursors and rejects unknown versions or providers", () => {
    for (const provider of ["grok", "opencode"]) {
      expect(usageSessionIdentity(provider, { schemaVersion: 1, sessionId: "native" })).toBe(
        "native",
      );
      expect(usageSessionIdentity(provider, { schemaVersion: 2, sessionId: "native" })).toBeNull();
    }
    expect(usageSessionIdentity("cursor", { threadId: "native" })).toBeNull();
    expect(usageSessionIdentity("codex", null)).toBeNull();
  });
});
