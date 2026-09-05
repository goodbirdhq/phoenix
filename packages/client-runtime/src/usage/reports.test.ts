import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentSessionUsage } from "@t3tools/shared/usageMerge";
import { buildUsageReport } from "./reports.ts";

const session: EnvironmentSessionUsage = {
  environmentId: EnvironmentId.make("env"),
  environmentLabel: "Environment",
  provider: "codex",
  sourceId: "home",
  sessionId: "native",
  attribution: "linked",
  firstActivityAt: "2026-09-01T00:00:00Z",
  lastActivityAt: "2026-09-01T00:00:00Z",
  thread: {
    id: "thread",
    title: "Work",
    createdAt: "2026-08-01T00:00:00Z",
    projectId: "project",
    projectTitle: "Phoenix",
    projectWorkspaceRoot: "/workspace",
    projectFaviconPath: null,
  },
  models: [
    {
      model: "model",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 5,
        outputTokens: 10,
        reasoningTokens: 5,
      },
      records: 1,
      unpricedRecords: 0,
      costUsd: 2,
      cacheSavingsUsd: 1,
    },
  ],
};
describe("usage reports", () => {
  it("combines a thread's native sessions and models without counting reasoning twice", () => {
    const rows = buildUsageReport(
      [
        session,
        { ...session, sessionId: "second", models: [{ ...session.models[0]!, model: "other" }] },
      ],
      "threads",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessions: 2,
      models: ["model", "other"],
      costUsd: 4,
      totalTokens: 90,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
    });
  });
  it("groups projects within each environment, retaining unlinked cost", () => {
    const rows = buildUsageReport(
      [
        session,
        { ...session, environmentId: EnvironmentId.make("other") },
        { ...session, attribution: "unlinked", thread: undefined },
      ],
      "projects",
    );
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBe(6);
    expect(rows.some((row) => row.title === "Unattributed usage")).toBe(true);
  });
});
