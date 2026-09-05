import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_SIDEBAR_FILTERS,
  pruneSidebarFilters,
  hasUnseenSidebarWake,
  activeSidebarFilterCount,
  matchesSidebarDraftFilters,
  matchesSidebarThreadFilters,
  sidebarAccountKey,
} from "./SidebarFilters.logic";
import { visibleSidebarTeams } from "./SidebarTeam.logic";

const shell = (overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell => ({
  id: ThreadId.make("parent"),
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  title: "Conversation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model-a" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  session: null,
  latestUserMessageAt: null,
  createdAt: "2026-09-05T10:00:00Z",
  updatedAt: "2026-09-05T10:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});
const context = { section: "active", lastVisitedAt: undefined, woke: false } as const;

describe("sidebar conversation filters", () => {
  it("uses OR within each category and AND across categories", () => {
    const filters = {
      ...EMPTY_SIDEBAR_FILTERS,
      environments: ["local", "remote"],
      models: ["model-a", "model-b"],
      statuses: ["working", "input"],
    };
    expect(
      matchesSidebarThreadFilters(shell({ hasPendingUserInput: true }), filters, context),
    ).toBe(true);
    expect(matchesSidebarThreadFilters(shell(), filters, context)).toBe(false);
    expect(
      matchesSidebarThreadFilters(
        shell({ environmentId: EnvironmentId.make("other"), hasPendingUserInput: true }),
        filters,
        context,
      ),
    ).toBe(false);
  });
  it("scopes provider accounts to their environment, even when instance IDs match", () => {
    const filters = { ...EMPTY_SIDEBAR_FILTERS, accounts: [sidebarAccountKey("remote", "codex")] };
    expect(matchesSidebarThreadFilters(shell(), filters, context)).toBe(false);
    expect(
      matchesSidebarThreadFilters(
        shell({ environmentId: EnvironmentId.make("remote") }),
        filters,
        context,
      ),
    ).toBe(true);
  });
  it("finds a child waiting on its parent even when the parent does not match", () => {
    const parent = shell();
    const child = shell({
      id: ThreadId.make("child"),
      spawnedByThreadId: parent.id,
      awaitingParentReplySince: "2026-09-05T11:00:00Z",
    });
    const filters = { ...EMPTY_SIDEBAR_FILTERS, statuses: ["awaiting-parent"] };
    const matching = [parent, child].filter((thread) =>
      matchesSidebarThreadFilters(thread, filters, context),
    );
    expect(visibleSidebarTeams(matching, new Set()).map((row) => row.thread.id)).toEqual([
      child.id,
    ]);
  });
  it("uses the effective shelf for snoozed and settled filters", () => {
    const filters = { ...EMPTY_SIDEBAR_FILTERS, statuses: ["snoozed", "settled"] };
    expect(matchesSidebarThreadFilters(shell(), filters, context)).toBe(false);
    expect(matchesSidebarThreadFilters(shell(), filters, { ...context, section: "settled" })).toBe(
      true,
    );
    expect(matchesSidebarThreadFilters(shell(), filters, { ...context, section: "snoozed" })).toBe(
      true,
    );
  });
  it("matches unread completions with the same visited semantics as the rows", () => {
    const thread = shell({
      latestTurn: {
        turnId: TurnId.make("turn"),
        state: "completed",
        requestedAt: "2026-09-05T10:00:00Z",
        startedAt: null,
        completedAt: "2026-09-05T11:00:00Z",
        assistantMessageId: null,
      },
    });
    const filters = { ...EMPTY_SIDEBAR_FILTERS, statuses: ["unread"] };
    expect(matchesSidebarThreadFilters(thread, filters, context)).toBe(false);
    expect(
      matchesSidebarThreadFilters(thread, filters, {
        ...context,
        lastVisitedAt: "2026-09-05T10:00:00Z",
      }),
    ).toBe(true);
    expect(
      matchesSidebarThreadFilters(thread, filters, {
        ...context,
        lastVisitedAt: "2026-09-05T12:00:00Z",
      }),
    ).toBe(false);
  });
  it("counts active categories rather than selected items", () => {
    expect(
      activeSidebarFilterCount({
        ...EMPTY_SIDEBAR_FILTERS,
        projects: ["a", "b"],
        models: ["a", "b"],
      }),
    ).toBe(2);
    expect(activeSidebarFilterCount(EMPTY_SIDEBAR_FILTERS)).toBe(0);
  });
  it("filters drafts by their chosen account and model without assigning an agent status", () => {
    const session = { environmentId: "local" };
    const composer = {
      activeProvider: "codex",
      modelSelectionByProvider: { codex: { model: "model-a" } },
    };
    const filters = {
      ...EMPTY_SIDEBAR_FILTERS,
      accounts: [sidebarAccountKey("local", "codex")],
      models: ["model-a"],
    };
    expect(matchesSidebarDraftFilters(session, composer, filters)).toBe(true);
    expect(matchesSidebarDraftFilters({ environmentId: "remote" }, composer, filters)).toBe(false);
    expect(matchesSidebarDraftFilters(session, undefined, filters)).toBe(false);
    expect(matchesSidebarDraftFilters(session, composer, { ...filters, statuses: ["ready"] })).toBe(
      false,
    );
  });
});

describe("filter target removal", () => {
  it("drops removed targets while retaining existing selections and historic models", () => {
    const filters = {
      ...EMPTY_SIDEBAR_FILTERS,
      projects: ["gone", "kept"],
      environments: ["gone-env"],
      accounts: ["gone-account"],
      models: ["historic"],
    };
    expect(
      pruneSidebarFilters(filters, {
        projects: new Set(["kept"]),
        environments: new Set(["offline-env"]),
        accounts: new Set(),
      }),
    ).toEqual({ ...EMPTY_SIDEBAR_FILTERS, projects: ["kept"], models: ["historic"] });
  });
  it("keeps disconnected environments and accounts while their cached targets still exist", () => {
    const filters = {
      ...EMPTY_SIDEBAR_FILTERS,
      environments: ["offline"],
      accounts: [sidebarAccountKey("offline", "codex")],
    };
    expect(
      pruneSidebarFilters(filters, {
        projects: new Set(),
        environments: new Set(["offline"]),
        accounts: new Set(filters.accounts),
      }),
    ).toBe(filters);
  });
});

describe("wake filtering", () => {
  it("includes an unseen wake in the settled shelf and clears on a visit", () => {
    const filters = { ...EMPTY_SIDEBAR_FILTERS, statuses: ["woke"] };
    const wokeAt = "2026-09-05T12:00:00Z";
    expect(
      matchesSidebarThreadFilters(shell(), filters, {
        ...context,
        section: "settled",
        woke: hasUnseenSidebarWake(wokeAt, "2026-09-05T11:00:00Z"),
      }),
    ).toBe(true);
    expect(hasUnseenSidebarWake(wokeAt, "2026-09-05T13:00:00Z")).toBe(false);
    expect(hasUnseenSidebarWake(wokeAt, "invalid")).toBe(true);
    expect(hasUnseenSidebarWake("invalid", undefined)).toBe(false);
  });
});
