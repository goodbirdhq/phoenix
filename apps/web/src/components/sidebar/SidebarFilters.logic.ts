import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { parseTimestampDate } from "../../timestampFormat";
import type { ThreadChangeRequestSnapshot } from "../ThreadStatusIndicators";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

export const SIDEBAR_FILTER_STATUSES = [
  { key: "approval", label: "Pending approval" },
  { key: "input", label: "Awaiting input" },
  { key: "awaiting-parent", label: "Waiting on parent" },
  { key: "working", label: "Working" },
  { key: "monitoring", label: "Monitoring" },
  { key: "failed", label: "Failed" },
  { key: "ready", label: "Ready" },
  { key: "unread", label: "Unread" },
  { key: "woke", label: "Woke" },
  { key: "pinned", label: "Pinned" },
  { key: "snoozed", label: "Snoozed" },
  { key: "settled", label: "Settled" },
] as const;

export interface SidebarFilters {
  projects: readonly string[];
  environments: readonly string[];
  statuses: readonly string[];
  accounts: readonly string[];
  models: readonly string[];
}
export const EMPTY_SIDEBAR_FILTERS: SidebarFilters = {
  projects: [],
  environments: [],
  statuses: [],
  accounts: [],
  models: [],
};
export function sidebarAccountKey(environmentId: string, instanceId: string) {
  return JSON.stringify([environmentId, instanceId]);
}
export function activeSidebarFilterCount(filters: SidebarFilters) {
  return Object.values(filters).filter((values) => values.length > 0).length;
}
export function matchesSidebarSelection(selected: readonly string[], value: string) {
  return selected.length === 0 || selected.includes(value);
}
export function matchesSidebarThreadFilters(
  thread: EnvironmentThreadShell,
  filters: SidebarFilters,
  context: {
    section: "active" | "pinned" | "snoozed" | "settled";
    lastVisitedAt: string | undefined;
    woke: boolean;
  },
) {
  if (
    !matchesSidebarSelection(filters.environments, thread.environmentId) ||
    !matchesSidebarSelection(
      filters.accounts,
      sidebarAccountKey(
        thread.environmentId,
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
      ),
    ) ||
    !matchesSidebarSelection(filters.models, thread.modelSelection.model)
  )
    return false;
  if (filters.statuses.length === 0) return true;
  const status = resolveSidebarThreadStatus(thread);
  return filters.statuses.some(
    (selected) =>
      selected === status ||
      (selected === "unread" &&
        hasUnseenCompletion({ ...thread, lastVisitedAt: context.lastVisitedAt })) ||
      (selected === "woke" && context.woke) ||
      (selected === "pinned" && thread.pinnedAt != null) ||
      selected === context.section,
  );
}

export function matchesSidebarDraftFilters(
  session: { environmentId: string },
  composer:
    | {
        activeProvider: string | null;
        modelSelectionByProvider: Partial<Record<string, { model: string }>>;
      }
    | undefined,
  filters: SidebarFilters,
) {
  if (filters.statuses.length > 0) return false;
  const instanceId = composer?.activeProvider;
  const model = instanceId ? composer?.modelSelectionByProvider[instanceId]?.model : undefined;
  return (
    matchesSidebarSelection(filters.environments, session.environmentId) &&
    (filters.accounts.length === 0 ||
      (instanceId != null &&
        filters.accounts.includes(sidebarAccountKey(session.environmentId, instanceId)))) &&
    (filters.models.length === 0 || (model !== undefined && filters.models.includes(model)))
  );
}

export function pruneSidebarFilters(
  filters: SidebarFilters,
  available: {
    projects: ReadonlySet<string>;
    environments: ReadonlySet<string>;
    accounts: ReadonlySet<string>;
  },
): SidebarFilters {
  const projects = filters.projects.filter((key) => available.projects.has(key));
  const environments = filters.environments.filter((key) => available.environments.has(key));
  const accounts = filters.accounts.filter((key) => available.accounts.has(key));
  if (
    projects.length === filters.projects.length &&
    environments.length === filters.environments.length &&
    accounts.length === filters.accounts.length
  )
    return filters;
  return { ...filters, projects, environments, accounts };
}

export function hasUnseenSidebarWake(wokeAt: string | null, lastVisitedAt: string | undefined) {
  const wake = wokeAt === null ? null : parseTimestampDate(wokeAt);
  const visit = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  return wake !== null && (visit === null || visit < wake);
}

export function resolveSidebarSnapshotPr(
  thread: EnvironmentThreadShell,
  snapshot: ThreadChangeRequestSnapshot | undefined,
) {
  return snapshot != null &&
    (thread.linkedPullRequest == null
      ? thread.worktreePath === null || snapshot.branch === thread.branch
      : snapshot.linkedPullRequest?.projectId === thread.linkedPullRequest.projectId &&
        snapshot.linkedPullRequest.repository === thread.linkedPullRequest.repository &&
        snapshot.linkedPullRequest.number === thread.linkedPullRequest.number)
    ? snapshot.pr
    : null;
}
