import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionsPanel } from "./SessionsPanel";
import { buildSessionPanelModel } from "./SessionsPanel.logic";

function shell(overrides: Record<string, unknown> & { id: string }) {
  return {
    projectId: "project-1",
    title: "Child session",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    runtimeMode: "full-access",
    interactionMode: "agent",
    branch: "t3code/05538d72",
    worktreePath: "/tmp/worktree",
    spawnedByThreadId: "parent-1",
    latestTurn: null,
    createdAt: "2026-08-17T22:38:00.000Z",
    updatedAt: "2026-08-17T22:38:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

function render(children: ReadonlyArray<OrchestrationThreadShell>) {
  return renderToStaticMarkup(
    <SessionsPanel model={buildSessionPanelModel(children)} onOpenThread={() => undefined} />,
  );
}

describe("SessionsPanel", () => {
  it("explains the surface when the thread has spawned nothing", () => {
    const markup = render([]);
    expect(markup).toContain("No sessions yet");
    expect(markup).not.toContain("<button");
  });

  it("makes every session a labelled way back into its chat", () => {
    const markup = render([
      shell({ id: "child-1", title: "Fix PR #27 provider ledger", session: { status: "running" } }),
    ]);
    expect(markup).toContain('aria-label="Open session: Fix PR #27 provider ledger"');
    expect(markup).toContain("<button");
    expect(markup).toContain("claude-opus-5");
    expect(markup).toContain("t3code/05538d72");
  });

  it("separates live sessions from settled history", () => {
    const markup = render([
      shell({ id: "child-1", title: "Still going", session: { status: "running" } }),
      shell({ id: "child-2", title: "All done", settledAt: "2026-08-17T23:10:00.000Z" }),
    ]);
    expect(markup).toContain("Active");
    expect(markup).toContain("Settled");
    expect(markup.indexOf("Still going")).toBeLessThan(markup.indexOf("All done"));
    expect(markup).toContain("1 working");
    expect(markup).toContain("1 settled");
  });

  it("says a settled session can no longer be resumed once its worktree is gone", () => {
    const markup = render([
      shell({ id: "child-1", settledAt: "2026-08-17T23:10:00.000Z", worktreePath: null }),
    ]);
    expect(markup).toContain("Settled · worktree reclaimed");
  });

  it("leads with the session that needs the user, not with what it was doing", () => {
    const markup = render([
      shell({
        id: "child-1",
        hasPendingApprovals: true,
        session: { status: "running" },
      }),
    ]);
    expect(markup).toContain("Needs you");
    expect(markup).toContain("1 needs you");
    expect(markup).not.toContain("1 working");
  });
});
