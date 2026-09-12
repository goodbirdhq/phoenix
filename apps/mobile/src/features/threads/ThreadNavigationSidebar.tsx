import { useThreadAttentionPreferences } from "./use-thread-attention";
import { useSessionRefresh } from "../home/use-session-refresh";
import { HomeHeader } from "../home/HomeHeader";
import { NavigationFooter } from "../home/NavigationFooter";
import type { FooterRootNavigation } from "../home/navigation-footer-layout";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { createThreadMovePlanner } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppText as Text } from "../../components/AppText";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2Enabled } from "./use-thread-list-v2-enabled";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { usePendingThreadOrder } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHomeListOptions } from "../home/home-list-options";
import {
  buildHomeListLayout,
  DEFAULT_GROUP_DISPLAY_STATE,
  EMPTY_HOME_LIST_LAYOUT,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeListItem,
} from "../home/homeListItems";
import { buildHomeProjectScopes, buildHomeThreadGroups } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  PendingTaskListRow,
  ThreadListGroupHeader,
  ThreadListRow,
  ThreadListShowMoreRow,
} from "./thread-list-items";
import {
  ThreadListV2SectionDivider,
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import { resolveThreadProviderInstance } from "./thread-provider-instance";
import {
  buildThreadListV2Items,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";

/** The sidebar list serves both lists: v1 grouped items or, when the Thread
    List v2 beta is on, flat v2 rows with queued tasks spliced in, and a settled
    "Show more" pager. */
type SidebarListItem =
  | HomeListItem
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number };

interface ThreadNavigationSidebarProps {
  readonly onStartNewTask: () => void;
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
  readonly rootNavigation?: FooterRootNavigation;
}

/** The tablet column shares the phone's navigation controls and list. */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  // Keep the Phoenix header/footer shell so tablet navigation exposes the
  // same environment and orchestration controls as the phone home screen.
  const colors = useNavigationColors();
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const {
    archiveThread,
    confirmDeleteThread,
    deleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    moveThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const threadListV2Enabled = useThreadListV2Enabled();
  const pendingTasks = usePendingNewTasks();
  const queuedThreadKeys = useQueuedThreadKeys();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options, setSelectedEnvironmentId, setProjectSortOrder, setThreadSortOrder } =
    useHomeListOptions(availableEnvironmentIds);
  const refresh = useSessionRefresh(environments, options.selectedEnvironmentId);
  const searchEnvironmentIds = useMemo(
    () =>
      options.selectedEnvironmentId === null
        ? workspaceEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : workspaceEnvironments.some(
              (environment) =>
                environment.environmentId === options.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [options.selectedEnvironmentId]
          : [],
    [options.selectedEnvironmentId, workspaceEnvironments],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, options.selectedEnvironmentId, projects],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const scopedProjects = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? projects
          : projects.filter((project) =>
              selectedProjectRefs.has(scopedProjectKey(project.environmentId, project.id)),
            ),
    [threadListV2Enabled, projects, selectedProjectRefs],
  );
  const scopedThreads = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? threads
          : threads.filter((thread) =>
              selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId)),
            ),
    [threadListV2Enabled, selectedProjectRefs, threads],
  );
  const scopedPendingTasks = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : selectedProjectRefs === null
          ? pendingTasks
          : pendingTasks.filter((pendingTask) =>
              selectedProjectRefs.has(
                scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
              ),
            ),
    [threadListV2Enabled, pendingTasks, selectedProjectRefs],
  );
  const groups = useMemo(
    () =>
      threadListV2Enabled
        ? []
        : buildHomeThreadGroups({
            projects: scopedProjects,
            threads: scopedThreads,
            pendingTasks: scopedPendingTasks,
            queuedThreadKeys,
            environmentId: options.selectedEnvironmentId,
            searchQuery: props.searchQuery,
            matchedThreadKeys,
            projectSortOrder: options.projectSortOrder,
            threadSortOrder: options.threadSortOrder,
            projectGroupingMode: options.projectGroupingMode,
          }),
    [
      threadListV2Enabled,
      queuedThreadKeys,
      matchedThreadKeys,
      options,
      props.searchQuery,
      scopedPendingTasks,
      scopedProjects,
      scopedThreads,
    ],
  );
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const updateGroupDisplay = useCallback((key: string, action: HomeGroupDisplayAction) => {
    setGroupDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(previous.get(key) ?? DEFAULT_GROUP_DISPLAY_STATE, action),
      );
      return next;
    });
  }, []);
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const listLayout = useMemo(
    () =>
      threadListV2Enabled
        ? EMPTY_HOME_LIST_LAYOUT
        : buildHomeListLayout({
            groups,
            displayStates: groupDisplayStates,
            showAllThreads: hasSearchQuery,
          }),
    [threadListV2Enabled, groups, groupDisplayStates, hasSearchQuery],
  );
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  // Thread List v2 (beta) support — same model as the compact Home list
  // (HomeScreen.tsx): flat creation-order card block + settled recency tail.
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the pane stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    if (!threadListV2Enabled) return;
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, [threadListV2Enabled]);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const activeReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadActiveReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const machineByEnvironmentId = useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    [serverConfigs],
  );
  const { attentionFirstEnabled, lastVisitedAtByKey } = useThreadAttentionPreferences();
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  const threadMovePlanners = useMemo(() => {
    const sectionPlanner = (section: "pinned" | "active") =>
      createThreadMovePlanner({
        allThreads: threads,
        section,
        reorderableEnvironmentIds: new Set(
          [...serverConfigs].flatMap(([id, config]) =>
            (section === "pinned"
              ? config.environment.capabilities.threadPinReorder
              : config.environment.capabilities.threadActiveReorder) === true
              ? [id]
              : [],
          ),
        ),
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    return { pinned: sectionPlanner("pinned"), active: sectionPlanner("active") };
  }, [
    serverConfigs,
    threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    nowMinute,
    snoozeWakeTick,
  ]);
  const threadListV2Layout = useMemo(() => {
    if (!threadListV2Enabled)
      return {
        items: [],
        hiddenSettledCount: 0,
        snoozedCount: 0,
        snoozedShelfHeaderIndex: null,
        settledCount: 0,
        settledShelfHeaderIndex: null,
        nextSnoozeWakeAt: null,
      };
    return buildThreadListV2Items({
      attentionFirstEnabled,
      lastVisitedAtByKey,
      pendingOrder,
      threads: threads.filter((thread) => thread.archivedAt === null),
      environmentId: options.selectedEnvironmentId,
      projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledLimit: settledVisibleCount,
      now: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey: props.selectedThreadKey ?? null,
    });
  }, [
    attentionFirstEnabled,
    lastVisitedAtByKey,
    pendingOrder,
    queuedThreadKeys,
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    props.selectedThreadKey,
    options.selectedEnvironmentId,
    props.searchQuery,
    matchedThreadKeys,
    settledVisibleCount,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    threadListV2Enabled,
    threads,
    selectedProjectScope,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    if (!threadListV2Enabled) return listLayout.items;
    // Queued offline tasks are not thread shells, so the v2 item builder
    // never sees them; the shared splice puts them below the active block
    // (mirrors the compact Home v2 list) where they stay visible and
    // deletable while their environment is offline. Same environment scope
    // and search filter as the list.
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        (options.selectedEnvironmentId === null ||
          pendingTask.environmentId === options.selectedEnvironmentId) &&
        (selectedProjectRefs === null ||
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    );
    const items: SidebarListItem[] = buildThreadListV2ListItems({
      items: threadListV2Layout.items,
      pendingTasks: v2PendingTasks,
      snoozedCount: threadListV2Layout.snoozedCount,
      snoozedShelfExpanded,
      snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
      settledCount: threadListV2Layout.settledCount,
      settledShelfExpanded,
      settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
      snoozeLabelNow: `${nowMinute}:00.000Z`,
    });
    if (settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      });
    }
    return items;
  }, [
    listLayout.items,
    nowMinute,
    options.selectedEnvironmentId,
    pendingTasks,
    props.searchQuery,
    selectedProjectRefs,
    settledShelfExpanded,
    snoozedShelfExpanded,
    threadListV2Enabled,
    threadListV2Layout,
  ]);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Project shells load after the first rows draw, so the maps they feed have
  // to bust the recycler's memoization — otherwise a row keeps the blank
  // favicon and fallback title it was first rendered with.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      projectByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      props.selectedThreadKey,
      projectByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
    ],
  );
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (previous.type === "v2-thread" && item.type === "v2-thread") {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.snoozed === item.item.snoozed &&
          previous.item.pinned === item.item.pinned &&
          previous.agentThreads?.length === item.agentThreads?.length &&
          (previous.agentThreads?.every((thread, index) => thread === item.agentThreads?.[index]) ??
            true) &&
          previous.snoozeWakeLabelText === item.snoozeWakeLabelText
        );
      }
      if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
        return previous.hiddenCount === item.hiddenCount;
      }
      if (previous.type === "v2-pending" && item.type === "v2-pending") {
        return (
          previous.pendingTask === item.pendingTask &&
          previous.showPendingDivider === item.showPendingDivider
        );
      }
      if (previous.type === "v2-snoozed-shelf" && item.type === "v2-snoozed-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (previous.type === "v2-settled-shelf" && item.type === "v2-settled-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (
        previous.type === "v2-section" ||
        item.type === "v2-section" ||
        previous.type === "v2-thread" ||
        previous.type === "v2-show-more" ||
        previous.type === "v2-pending" ||
        previous.type === "v2-snoozed-shelf" ||
        previous.type === "v2-settled-shelf" ||
        item.type === "v2-thread" ||
        item.type === "v2-show-more" ||
        item.type === "v2-pending" ||
        item.type === "v2-snoozed-shelf" ||
        item.type === "v2-settled-shelf"
      ) {
        return false;
      }
      return homeListItemsAreEqual(previous, item);
    },
    [],
  );
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      switch (item.type) {
        case "v2-section":
          return <ThreadListV2SectionDivider label={item.label} pane="sidebar" />;
        case "v2-pending": {
          const pendingScopeKey = scopedProjectKey(
            item.pendingTask.environmentId,
            item.pendingTask.projectId,
          );
          return (
            <ThreadListV2PendingRow
              pendingTask={item.pendingTask}
              project={projectByKey.get(pendingScopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
              pane="sidebar"
              showPendingDivider={item.showPendingDivider}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        }
        case "v2-thread": {
          const thread = item.item.thread;
          const movePlanner = item.item.pinned
            ? threadMovePlanners.pinned
            : threadMovePlanners.active;
          const movedId = `${thread.environmentId}:${thread.id}`;
          const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
          return (
            <ThreadListV2Row
              onNewThreadOnBranch={props.onNewThreadOnBranch}
              thread={thread}
              agentThreads={item.agentThreads}
              variant={item.item.variant}
              hasQueuedMessages={queuedThreadKeys.has(`${thread.environmentId}:${thread.id}`)}
              snoozed={item.item.snoozed}
              pinned={item.item.pinned}
              snoozeWakeLabelText={item.snoozeWakeLabelText}
              project={projectByKey.get(scopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(scopeKey)}
              providerInstance={resolveThreadProviderInstance(serverConfigs, thread)}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              pane="sidebar"
              selectedThreadKey={props.selectedThreadKey ?? undefined}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onConfirmDeleteThread={deleteThread}
              onArchiveThread={archiveThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
              pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
              reorderSupported={
                item.item.pinned
                  ? pinReorderEnvironmentIds.has(thread.environmentId)
                  : activeReorderEnvironmentIds.has(thread.environmentId)
              }
              canMoveUp={pendingOrder === null && movePlanner(movedId, "up") !== null}
              canMoveDown={pendingOrder === null && movePlanner(movedId, "down") !== null}
              snoozePresetMinute={nowMinute}
              onSnoozeThread={snoozeThread}
              onUnsnoozeThread={unsnoozeThread}
              onUnsettleThread={unsettleThread}
              onPinThread={pinThread}
              onUnpinThread={unpinThread}
              onMoveThread={moveThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSnoozedShelf}
              pane={materialYouStyleLayoutActive ? "screen" : "sidebar"}
            />
          );
        case "v2-settled-shelf":
          return (
            <ThreadListV2SettledShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSettledShelf}
              pane={materialYouStyleLayoutActive ? "screen" : "sidebar"}
            />
          );
        case "v2-show-more":
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(item.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
              onPress={showMoreSettled}
              className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                Show more ({item.hiddenCount} settled hidden)
              </Text>
            </Pressable>
          );
        case "header":
          return (
            <ThreadListGroupHeader
              variant={materialYouStyleLayoutActive ? "compact" : "sidebar"}
              collapsed={item.collapsed}
              isFirst={item.isFirst}
              groupKey={item.group.key}
              onGroupAction={updateGroupDisplay}
              // Same gating as the compact Home list: aggregated groups have no
              // single target project, and pending-project groups hold a
              // placeholder shell rather than a real project.
              newThreadTarget={item.group.newThreadTarget}
              onNewThread={props.onNewThreadInProject}
              project={item.group.representative}
              threadCount={item.group.threads.length + item.group.pendingTasks.length}
              title={item.group.title}
            />
          );
        case "pending-task":
          return (
            <PendingTaskListRow
              variant={materialYouStyleLayoutActive ? "compact" : "sidebar"}
              pendingTask={item.pendingTask}
              environmentLabel={
                savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null
              }
              environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
              isLast={item.isLast}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "thread": {
          const thread = item.thread;
          return (
            <ThreadListRow
              onNewThreadOnBranch={props.onNewThreadOnBranch}
              variant="sidebar"
              thread={thread}
              hasQueuedMessages={queuedThreadKeys.has(`${thread.environmentId}:${thread.id}`)}
              environmentLabel={
                savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
              }
              environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
              isLast={item.isLast}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onArchiveThread={archiveThread}
              onDeleteThread={confirmDeleteThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              onSelectThread={handleSelectThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "show-more":
          return (
            <ThreadListShowMoreRow
              variant={materialYouStyleLayoutActive ? "compact" : "sidebar"}
              hiddenCount={item.hiddenCount}
              canShowLess={item.canShowLess}
              groupKey={item.groupKey}
              onGroupAction={updateGroupDisplay}
            />
          );
      }
    },
    [
      materialYouStyleLayoutActive,
      archiveThread,
      activeReorderEnvironmentIds,
      threadMovePlanners,
      pendingOrder,
      queuedThreadKeys,
      confirmDeletePendingTask,
      confirmDeleteThread,
      deleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      machineByEnvironmentId,
      moveThread,
      openPendingTask,
      pinReorderEnvironmentIds,
      pinThread,
      pinningEnvironmentIds,
      projectByKey,
      projectTitleByProjectKey,
      regenerateThreadTitle,
      props.onNewThreadInProject,
      props.onNewThreadOnBranch,
      props.searchQuery,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      serverConfigs,
      shelfPreferencesLoaded,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      settleThread,
      settlementEnvironmentIds,
      showMoreSettled,
      sidebarScrollGesture,
      snoozeEnvironmentIds,
      snoozeThread,
      nowMinute,
      toggleSettledShelf,
      toggleSnoozedShelf,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateGroupDisplay,
    ],
  );
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const listEmpty = (
    <Text className="px-2 py-4 text-sm text-foreground-muted">
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : props.searchQuery.trim().length > 0
          ? threadSearch.isPending
            ? "Searching thread messages…"
            : "No matching threads"
          : selectedProjectScope !== null
            ? `No threads in ${selectedProjectScope.title}`
            : "No threads yet"}
    </Text>
  );

  return (
    <View
      testID="thread-navigation-sidebar"
      style={{
        flex: 1,
        width: props.width,
        backgroundColor: colors.screen,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
      }}
    >
      <HomeHeader
        {...refresh}
        hideNativeHeader={false}
        beforeFocusSearch={props.onRequestVisibility}
        environments={environments}
        projects={projectFilterOptions}
        searchQuery={props.searchQuery}
        selectedEnvironmentId={options.selectedEnvironmentId}
        selectedProjectKey={selectedProjectKey}
        projectSortOrder={options.projectSortOrder}
        threadSortOrder={options.threadSortOrder}
        onSearchQueryChange={props.onSearchQueryChange}
        onEnvironmentChange={setSelectedEnvironmentId}
        onProjectChange={setSelectedProjectKey}
        onProjectSortOrderChange={setProjectSortOrder}
        onThreadSortOrderChange={setThreadSortOrder}
        onStartNewTask={props.onStartNewTask}
      />
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <GestureDetector gesture={sidebarScrollGesture}>
          <LegendList
            alwaysBounceVertical
            refreshControl={
              <RefreshControl
                {...refresh}
                tintColor={colors.accent}
                accessibilityLabel="Refresh sessions"
                colors={[colors.accent]}
                progressBackgroundColor={colors.surface}
              />
            }
            data={listItems}
            drawDistance={500}
            estimatedItemSize={74}
            extraData={listExtraData}
            getItemType={(item) => item.type}
            itemsAreEqual={sidebarItemsAreEqual}
            keyExtractor={(item) => item.key}
            renderItem={renderListItem}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 16 }}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            {...scrollGateHandlers}
            recycleItems
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            ListEmptyComponent={listEmpty}
          />
        </GestureDetector>
      </SwipeableScrollGateProvider>
      <NavigationFooter rootNavigation={props.rootNavigation} />
    </View>
  );
}
