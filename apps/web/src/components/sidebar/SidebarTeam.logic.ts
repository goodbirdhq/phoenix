import {
  buildSidebarThreadHierarchy,
  resolveSidebarThreadStatus,
  type SidebarHierarchyThreadInput,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

export const sidebarTeamKey = (thread: SidebarHierarchyThreadInput) =>
  `${thread.environmentId}:${thread.id}`;

/** A user can collapse the team containing the open conversation. Traversal
 * then starts at its visible ancestor without changing the open chat. */
export function sidebarNavigationAnchor(
  currentKey: string | null,
  visibleKeys: readonly string[],
  threads: ReadonlyMap<string, SidebarHierarchyThreadInput>,
) {
  const visible = new Set(visibleKeys);
  const visited = new Set<string>();
  let key = currentKey;
  while (key !== null && !visited.has(key)) {
    if (visible.has(key)) return key;
    visited.add(key);
    const thread = threads.get(key);
    key = thread?.spawnedByThreadId ? `${thread.environmentId}:${thread.spawnedByThreadId}` : null;
  }
  return null;
}

/** Membership is independent of expansion and pin placement. Settled and
 * snoozed threads are excluded by the caller, using the existing lifecycle. */
export function buildSidebarTeams<T extends SidebarHierarchyThreadInput>(threads: readonly T[]) {
  const teams = new Map<string, T[]>();
  const ancestors: T[] = [];
  for (const row of buildSidebarThreadHierarchy(threads)) {
    ancestors.length = row.depth;
    ancestors.push(row.thread);
    for (const ancestor of ancestors) {
      const key = sidebarTeamKey(ancestor);
      const members = teams.get(key);
      if (members) members.push(row.thread);
      else teams.set(key, [row.thread]);
    }
  }
  return teams;
}

/** Pinned threads own a separate root row; descendants still belong to their
 * original team for counts. Filtering never changes the caller's root order. */
export function visibleSidebarTeams<
  T extends SidebarHierarchyThreadInput & { pinnedAt?: string | null | undefined },
>(threads: readonly T[], expanded: ReadonlySet<string>) {
  const originals = new Map(threads.map((thread) => [sidebarTeamKey(thread), thread]));
  const rows = buildSidebarThreadHierarchy(
    threads.map((thread) =>
      thread.pinnedAt != null ? { ...thread, spawnedByThreadId: null } : thread,
    ),
  );
  let hiddenBelow = Infinity;
  return rows
    .filter((row) => {
      if (row.depth > hiddenBelow) return false;
      hiddenBelow = expanded.has(sidebarTeamKey(row.thread)) ? Infinity : row.depth;
      return true;
    })
    .map((row) => ({ ...row, thread: originals.get(sidebarTeamKey(row.thread))! }));
}

const statusPriority: Record<SidebarThreadStatus, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  working: 3,
  monitoring: 4,
  ready: 5,
};

/** Expansion transfers descendant signals to their visible rows. The target
 * is the conversation to open for the next action, not always the parent. */
export function resolveSidebarTeamStatus<
  T extends Parameters<typeof resolveSidebarThreadStatus>[0],
>(parent: T, members: readonly T[], expanded: boolean) {
  let target = parent;
  let status = resolveSidebarThreadStatus(parent);
  let workingCount = 0;
  for (const member of expanded ? [parent] : members) {
    const next = resolveSidebarThreadStatus(member);
    if (next === "working") workingCount++;
    if (statusPriority[next] < statusPriority[status]) {
      status = next;
      target = member;
    }
  }
  return { status, target, workingCount };
}
