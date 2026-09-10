import { describe, expect, it } from "@effect/vitest";
import type { UsageSession, UsageSource } from "@t3tools/contracts";
import { attributeUsageSessions, type UsageSessionLink } from "./usageAttribution.ts";

const session: UsageSession = {
  provider: "claude",
  sourceId: "home",
  sessionId: "native",
  firstActivityAt: "2026-09-01T00:00:00Z",
  lastActivityAt: "2026-09-02T00:00:00Z",
  models: [],
};
const source: UsageSource = {
  id: "home",
  fingerprint: { provider: "claude", hostId: "host", resolvedHomePath: "/claude", volumeId: "1" },
  configuredInstanceIds: ["claude-a"],
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
};
const link: UsageSessionLink = {
  providerName: "claudeAgent",
  providerInstanceId: "claude-a",
  sessionId: "native",
  thread: {
    id: "thread",
    title: "Work",
    createdAt: "2026-08-01T00:00:00Z",
    projectId: "project",
    projectTitle: "Phoenix",
    projectWorkspaceRoot: "/workspace",
    projectFaviconPath: null,
  },
};

describe("usage attribution", () => {
  it("uses recorded native identity and preserves the actual thread creation time", () => {
    const [result] = attributeUsageSessions([session], [source], [link]);
    expect(result?.attribution).toBe("linked");
    expect(result?.thread).toEqual(link.thread);
  });
  it("does not guess from an unknown store, another instance, or another provider", () => {
    expect(
      attributeUsageSessions(
        [session],
        [{ ...source, configuredInstanceIds: undefined }],
        [link],
      )[0]?.attribution,
    ).toBe("unlinked");
    for (const changed of [
      { ...link, providerInstanceId: "claude-b" },
      { ...link, providerName: "codex" },
    ]) {
      expect(attributeUsageSessions([session], [source], [changed])[0]?.thread).toBeUndefined();
    }
  });
  it("retains ambiguity when multiple threads resumed the same native history", () => {
    const [result] = attributeUsageSessions(
      [session],
      [source],
      [link, { ...link, thread: { ...link.thread, id: "other" } }],
    );
    expect(result?.attribution).toBe("ambiguous");
    expect(result?.thread).toBeUndefined();
  });
  it("does not treat two instance links to the same thread as two threads", () => {
    const [result] = attributeUsageSessions(
      [session],
      [{ ...source, configuredInstanceIds: ["claude-a", "claude-b"] }],
      [link, { ...link, providerInstanceId: "claude-b" }],
    );
    expect(result?.attribution).toBe("linked");
  });
});
