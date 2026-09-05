import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildSidebarTeams,
  visibleSidebarTeams,
  resolveSidebarTeamStatus,
  sidebarTeamKey,
  sidebarNavigationAnchor,
} from "./SidebarTeam.logic";

const thread = (id: string, parent: string | null = null, environmentId = "local") => ({
  id,
  environmentId,
  spawnedByThreadId: parent,
  pinnedAt: null as string | null,
  awaitingParentReplySince: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  backgroundLiveness: "working" as const,
});

describe("sidebar teams", () => {
  const parent = thread("parent");
  const child = thread("child", "parent");
  const grandchild = { ...thread("grandchild", "child"), hasPendingUserInput: true };

  it("counts every descendant once, parent first, including a separately pinned child", () => {
    const pinned = { ...child, pinnedAt: "2026-09-05" };
    const teams = buildSidebarTeams([pinned, parent, grandchild, parent]);
    expect(teams.get(sidebarTeamKey(parent))?.map((entry) => entry.id)).toEqual([
      "parent",
      "child",
      "grandchild",
    ]);
    expect(teams.get(sidebarTeamKey(child))?.map((entry) => entry.id)).toEqual([
      "child",
      "grandchild",
    ]);
  });

  it("opens one level at a time and restores subtree status when collapsed", () => {
    const threads = [parent, child, grandchild];
    expect(visibleSidebarTeams(threads, new Set()).map((row) => row.thread.id)).toEqual(["parent"]);
    expect(
      visibleSidebarTeams(threads, new Set(["local:parent"])).map((row) => row.thread.id),
    ).toEqual(["parent", "child"]);
    const expanded = visibleSidebarTeams(threads, new Set(["local:parent", "local:child"]));
    expect(expanded.map((row) => [row.thread.id, row.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
    expect(resolveSidebarTeamStatus(parent, threads, false)).toEqual({
      status: "input",
      target: grandchild,
      workingCount: 2,
    });
    expect(resolveSidebarTeamStatus(parent, threads, true)).toEqual({
      status: "working",
      target: parent,
      workingCount: 1,
    });
    expect(resolveSidebarTeamStatus(child, [child, grandchild], false).target).toBe(grandchild);
    expect(resolveSidebarTeamStatus(child, [child, grandchild], true).target).toBe(child);
  });

  it("surfaces a descendant waiting on its parent until its team is expanded", () => {
    const waiting = { ...child, awaitingParentReplySince: "2026-09-05T12:00:00Z" };
    expect(resolveSidebarTeamStatus(parent, [parent, waiting], false)).toMatchObject({
      status: "awaiting-parent",
      target: waiting,
      workingCount: 1,
    });
    expect(resolveSidebarTeamStatus(parent, [parent, waiting], true).status).toBe("working");
    expect(resolveSidebarTeamStatus(waiting, [waiting], true).status).toBe("awaiting-parent");
    expect(resolveSidebarTeamStatus(parent, [parent, waiting, grandchild], false).status).toBe(
      "input",
    );
  });

  it("shows a pinned child separately without duplicating it inside an expanded parent", () => {
    const pinned = { ...child, pinnedAt: "2026-09-05" };
    const rows = visibleSidebarTeams(
      [pinned, parent, grandchild],
      new Set(["local:parent", "local:child"]),
    );
    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["child", 0],
      ["grandchild", 1],
      ["parent", 0],
    ]);
    expect(rows[0]?.thread.spawnedByThreadId).toBe("parent");
  });

  it("keeps completed children visible until lifecycle removes them and releases orphaned children", () => {
    const done = { ...grandchild, hasPendingUserInput: false, backgroundLiveness: undefined };
    const rows = visibleSidebarTeams([child, done], new Set(["local:child"]));
    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      ["child", 0],
      ["grandchild", 1],
    ]);
    expect(buildSidebarTeams([child, done]).get("local:child")).toHaveLength(2);
  });

  it("does not attach equal thread IDs from different environments and tolerates cycles", () => {
    const remoteChild = thread("child", "parent", "remote");
    expect(visibleSidebarTeams([parent, remoteChild], new Set())).toHaveLength(2);
    const cycle = [thread("a", "b"), thread("b", "a")];
    expect(buildSidebarTeams(cycle).get("local:a")).toHaveLength(2);
    expect(visibleSidebarTeams(cycle, new Set(["local:a", "local:b"]))).toHaveLength(2);
  });

  it("anchors navigation to the visible parent when the open grandchild is collapsed", () => {
    const threads = new Map(
      [parent, child, grandchild].map((entry) => [sidebarTeamKey(entry), entry]),
    );
    expect(sidebarNavigationAnchor("local:grandchild", ["local:parent"], threads)).toBe(
      "local:parent",
    );
    expect(
      sidebarNavigationAnchor("local:grandchild", ["local:parent", "local:child"], threads),
    ).toBe("local:child");
    expect(
      sidebarNavigationAnchor(
        "local:grandchild",
        ["local:parent", "local:child", "local:grandchild"],
        threads,
      ),
    ).toBe("local:grandchild");
    expect(sidebarNavigationAnchor("remote:grandchild", ["local:parent"], threads)).toBeNull();
  });

  it("prioritizes decisions, then input, then failure over ongoing work", () => {
    const error = {
      ...child,
      backgroundLiveness: undefined,
      session: {
        status: "error" as const,
        threadId: ThreadId.make("child"),
        providerName: "Codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "Failed",
        updatedAt: "2026-09-05T12:00:00Z",
      },
    };
    const decision = { ...grandchild, hasPendingApprovals: true };
    expect(
      resolveSidebarTeamStatus(parent, [parent, error, grandchild, decision], false).status,
    ).toBe("approval");
    expect(resolveSidebarTeamStatus(parent, [parent, error, grandchild], false).status).toBe(
      "input",
    );
    const waiting = { ...child, awaitingParentReplySince: "2026-09-05T12:00:00Z" };
    expect(resolveSidebarTeamStatus(parent, [parent, error, waiting], false).status).toBe("failed");
  });
});
