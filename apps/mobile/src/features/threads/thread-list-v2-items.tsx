import * as Dialog from "../../components/ui/Dialog";
import {
  resolveThreadProviderInstance,
  type ThreadRowProviderInstance,
} from "./thread-provider-instance";
import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { getThreadRowColors } from "./thread-row-colors";
import { RowPressable } from "../../components/ui/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope, type EnvironmentMachineKind } from "@t3tools/contracts";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ThreadAvatar, ThreadAvatarMotionContext } from "../../components/ThreadAvatar";
import { useNavigationColors } from "../../components/useNavigationColors";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useProject } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  buildThreadAgentGroupHierarchy,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  threadHasUnseenCompletion,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  type ThreadAgentGroupNode,
  type ThreadListV2AgentRowStamp,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { ThreadAgentGroup } from "./ThreadAgentGroup";
import { threadIdentityLabel } from "./thread-avatar-status";
import {
  buildThreadRowAccessibilityLabel,
  pendingTaskRowAccessibility,
} from "./thread-row-accessibility";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";

interface StatusLabel {
  readonly label: string;
  readonly className: string;
}
// Status hues follow the system-wide convention (amber approval, indigo
// input, sky working) so a thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  waiting: { label: "Waiting", className: "text-foreground-muted" },
  failed: { label: "Failed", className: "text-danger-foreground" },
  limited: { label: "Limited", className: "text-warning-foreground" },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: "Done",
  className: "text-adaptive-emerald-700-300",
};

function ThreadListV2Duration(props: { readonly startedAt: string | null }) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs));
  if (!Number.isFinite(startedAtMs)) return null;
  return ` ${formatWorkingDurationLabel(nowMs - startedAtMs)}`;
}

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: "Settle", image: "checkmark" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: "Wake thread", image: "clock" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 mt-4 flex-row items-center gap-2.5",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane
            ? "text-drawer-foreground-muted"
            : snoozed
              ? "text-foreground-secondary"
              : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={props.disclosure.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

const SHELF_LABEL = { working: "Working", snoozed: "Snoozed", settled: "Settled" } as const;

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: keyof typeof SHELF_LABEL },
) {
  const label = SHELF_LABEL[props.kind];
  return (
    <ThreadListV2Section
      label={props.expanded ? label : `${label} (${props.count})`}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: `${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`,
      }}
    />
  );
}

export const ThreadListV2WorkingShelfHeader = memo(function ThreadListV2WorkingShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="working" />;
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        Show more ({props.hiddenCount} settled hidden)
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/** Rounded-row radius shared by thread, queued and draft rows. */
const THREAD_ROW_RADIUS = 12;

/**
 * Unsent work, in the same two-line idiom as a thread row: it is work the
 * user wrote, so it reads like the thread it will become. The status slot says
 * what happens next: "Sends on reconnect" stays uncolored because nothing is
 * asked of the user; "Draft" takes amber because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showPendingDivider: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const theme = useUniwindTheme();
  const colors = useNavigationColors();
  const sidebarPane = props.pane === "sidebar";
  const rowColors = getThreadRowColors(theme, sidebarPane, false);
  const isDraft = pendingTask.kind === "draft";
  const projectTitle = props.projectTitle ?? props.project?.title ?? pendingTask.projectTitle ?? "";
  const detail = [pendingTask.branch ?? projectTitle, props.environmentLabel]
    .filter(Boolean)
    .join(" · ");
  const accessibility = pendingTaskRowAccessibility({
    kind: pendingTask.kind,
    title: pendingTask.title,
    projectTitle,
    environmentLabel: props.environmentLabel,
  });

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Unsent" pane={props.pane} />
      ) : null}
      <Menu
        actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityActions={[{ name: "delete", label: accessibility.deleteActionLabel }]}
          accessibilityHint={accessibility.hint}
          accessibilityLabel={accessibility.label}
          accessibilityRole="button"
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "delete") onDeletePendingTask(pendingTask);
          }}
          key={pendingTask.key}
          interactionClassName={rowColors.interactionClassName}
          onPress={() => onSelectPendingTask(pendingTask)}
          style={{
            minHeight: 74,
            marginHorizontal: sidebarPane ? 0 : 14,
            marginBottom: 4,
            padding: 10,
            gap: 10,
            flexDirection: "row",
            alignItems: "center",
            borderRadius: THREAD_ROW_RADIUS,
            backgroundColor: rowColors.backgroundColor,
          }}
        >
          <View style={{ width: 32, height: 30, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {props.project ? (
                <ProjectFavicon
                  environmentId={pendingTask.environmentId}
                  faviconPath={props.project.faviconPath}
                  projectIcon={props.project.projectIcon}
                  projectTitle={projectTitle}
                  size={16}
                  workspaceRoot={props.project.workspaceRoot}
                />
              ) : null}
            </View>
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {/* A queued title is derived from the whole prompt rather than
                  written as a title, so one line keeps the row's height. */}
              <Text
                className={cn("font-t3-medium", rowColors.foregroundClassName)}
                numberOfLines={1}
                style={{ flex: 1, fontSize: 15, lineHeight: 22 }}
              >
                {pendingTask.title}
              </Text>
              {isDraft ? (
                <View className="flex-row items-center gap-1">
                  <SymbolView
                    name="square.and.pencil"
                    size={10}
                    tintColorClassName="accent-adaptive-amber-700-300"
                    type="monochrome"
                  />
                  <Text
                    className="text-adaptive-amber-700-300"
                    style={{ fontSize: 12, lineHeight: 17 }}
                  >
                    Draft
                  </Text>
                </View>
              ) : (
                <Text
                  className={rowColors.mutedForegroundClassName}
                  style={{ fontSize: 12, lineHeight: 17 }}
                >
                  Sends on reconnect
                </Text>
              )}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 26 }}>
              {detail ? (
                <Text
                  className={rowColors.mutedForegroundClassName}
                  numberOfLines={1}
                  style={{ flexShrink: 1, fontSize: 13, lineHeight: 19 }}
                >
                  {detail}
                </Text>
              ) : null}
              {props.environmentLabel && props.environmentMachine ? (
                <EnvironmentMachineSymbol
                  kind={props.environmentMachine}
                  size={11}
                  tintColorClassName={rowColors.mutedIconTintClassName}
                />
              ) : null}
            </View>
          </View>
        </RowPressable>
      </Menu>
    </>
  );
});

interface ThreadListV2RowProps {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly hasQueuedMessages?: boolean;
  readonly snoozed?: boolean;
  readonly pinned?: boolean;
  readonly wokeAt: string | null;
  /** Child sessions grouped under this row (see groupChildSessions). */
  readonly agentThreads?: ReadonlyArray<EnvironmentThreadShell> | undefined;
  /** The root row's per-child stamps, handed down unchanged so every nesting
      level reads its own entry. */
  readonly agentRowStamps?: ReadonlyMap<string, ThreadListV2AgentRowStamp> | undefined;
  /** Nesting level of an expanded child row; the root row is 0. */
  readonly hierarchyDepth?: number;
  /** The parent's project: a child in the same project leads with its provider. */
  readonly parentProjectId?: EnvironmentThreadShell["projectId"];
  /** Key of the thread open in the detail pane, for nested child rows. */
  readonly selectedThreadKey?: string | null;
  readonly snoozeWakeLabelText?: string;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly selected?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly pinningSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}

/**
 * Two lines beside the session avatar: title and time, then branch (or
 * project) · machine with the PR, child-session group and status word after
 * it. A failed session's last error takes the branch slot so the height holds.
 */
export const ThreadListV2Row = memo(function ThreadListV2Row(props: ThreadListV2RowProps) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    onSelectThread,
    onOpenThreadPullRequests,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const providerInstance = props.providerInstance;
  const providerIconUrl = useMemo(
    () =>
      props.providers?.find(
        (candidate) =>
          candidate.instanceId ===
          (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
      )?.iconUrl,
    [thread, props.providers],
  );
  const pr = useThreadPr(thread);
  const prBadgeLabel = pr ? resolveThreadPrBadgeAction(pr).accessibilityLabel : null;
  const handleOpenPullRequests = useCallback(() => {
    if (pr) onOpenThreadPullRequests(thread, pr);
  }, [onOpenThreadPullRequests, pr, thread]);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowColors = getThreadRowColors(theme, sidebarPane, selected);

  const status = resolveThreadListV2Status(thread);
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const showsWoke = status === "ready" && props.wokeAt !== null;
  const baseStatusLabel = STATUS_LABEL_BY_STATUS[status];
  const statusLabel =
    (status === "working" && baseStatusLabel !== undefined && thread.goal?.status === "active"
      ? { ...baseStatusLabel, label: "Goal" }
      : baseStatusLabel) ?? (isUnread ? DONE_STATUS_LABEL : undefined);
  const failedError =
    status === "failed" || status === "limited" ? (thread.runtime?.lastError ?? null) : null;

  const [groupExpanded, setGroupExpanded] = useState(true);
  const canExpandAgents = useMemo(
    () =>
      buildThreadAgentGroupHierarchy(props.agentThreads ?? []).some(
        (node) => node.thread.pinnedAt == null,
      ),
    [props.agentThreads],
  );
  const toggleAgents = () => {
    if (canExpandAgents) setGroupExpanded((value) => !value);
  };

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const handleAcknowledgeWoke = useCallback(() => {
    if (props.wokeAt === null) return;
    void visitThread({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: props.wokeAt },
    });
  }, [props.wokeAt, thread.environmentId, thread.id, visitThread]);
  // VoiceOver cannot focus buttons inside the accessible row.
  const rowAccessibilityActions = useMemo(
    () => [
      ...(prBadgeLabel ? [{ name: "openPullRequests", label: prBadgeLabel }] : []),
      ...(showsWoke ? [{ name: "dismissWoke", label: "Dismiss Woke notification" }] : []),
      ...(canExpandAgents
        ? [
            {
              name: "toggleAgents",
              label: groupExpanded ? "Collapse child sessions" : "Expand child sessions",
            },
          ]
        : []),
    ],
    [canExpandAgents, groupExpanded, prBadgeLabel, showsWoke],
  );
  // A recycled cell keeps this row mounted for another thread.
  const groupIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundGroupIdentity, setBoundGroupIdentity] = useState(groupIdentity);
  if (boundGroupIdentity !== groupIdentity) {
    setBoundGroupIdentity(groupIdentity);
    setGroupExpanded(false);
  }

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // A recycled cell reassigns this mounted row to a different thread without
  // remounting it, and the render closure stops running while list equality
  // says the item is unchanged — so any row-local UI state must be dismissed
  // when the identity under it changes.
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  const canUnsettle = variant === "slim";
  // The React Compiler caches render results on props and state, so a clock read
  // in render would stay frozen until `thread` changes: the gate could never
  // expire and its timer would re-fire every 50ms. The gate's clock is state.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({ thread, now: Date.now() }));
  if (snoozeGateClock.thread !== thread) setSnoozeGateClock({ thread, now: Date.now() });
  const snoozeGateNow = new Date(snoozeGateClock.now).toISOString();
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: snoozeGateNow })
    : null;
  useEffect(() => {
    // A gate still closed past its expiry is held by runtime status, not time,
    // so no clock tick can open it.
    if (snoozeGateExpiryMs === null || snoozeGateExpiryMs <= snoozeGateClock.now) return;
    const delayMs = Math.min(snoozeGateExpiryMs - Date.now() + 50, 2_147_483_647);
    const id = setTimeout(() => setSnoozeGateClock({ thread, now: Date.now() }), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateClock.now, thread]);
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: snoozeGateNow }),
    snoozed: snoozedRow,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: "Custom…" },
    ],
    [snoozePresets],
  );
  const arrangementMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(props.reorderSupported === true
        ? [
            { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
            {
              id: "move-up",
              title: "Move up",
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: "Move down",
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
      ...(props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? { id: "unpin", title: "Unpin", image: "pin.slash" }
              : { id: "pin", title: "Pin", image: "pin" },
          ]
        : []),
    ],
    [
      props.canMoveDown,
      props.canMoveUp,
      props.reorderSupported,
      props.pinningSupported,
      thread.pinnedAt,
      variant,
    ],
  );
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: "Auto-settle behavior",
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: "Enabled",
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: "Disabled",
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      { id: "rename", title: "Rename", image: "square.and.pencil" },
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
    ],
    [props.titleRegenerationSupported, thread.titleRegeneration],
  );
  const snoozableCardMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: "settle", title: "Settle", image: "checkmark" },
      {
        id: "snooze",
        title: "Snooze",
        image: "clock",
        subactions: snoozePresetActions,
      },
      ...arrangementMenuItems,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      LEGACY_MENU_ACTIONS[0]!,
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [arrangementMenuItems, autoSettleMenuItems, snoozePresetActions, titleMenuItems],
  );
  const cardMenuActions = useMemo<MenuAction[]>(
    () => [
      CARD_MENU_ACTIONS[0]!,
      ...arrangementMenuItems,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      LEGACY_MENU_ACTIONS[0]!,
      ...CARD_MENU_ACTIONS.slice(1),
    ],
    [arrangementMenuItems, autoSettleMenuItems, titleMenuItems],
  );
  const slimMenuActions = useMemo<MenuAction[]>(
    () => [
      SLIM_MENU_ACTIONS[0]!,
      ...arrangementMenuItems.filter(
        (action) => action.id !== "move-up" && action.id !== "move-down",
      ),
      ...titleMenuItems,
      ...autoSettleMenuItems,
      LEGACY_MENU_ACTIONS[0]!,
      SLIM_MENU_ACTIONS[1]!,
    ],
    [arrangementMenuItems, autoSettleMenuItems, titleMenuItems],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () => [
      SNOOZED_MENU_ACTIONS[0]!,
      ...titleMenuItems,
      ...autoSettleMenuItems,
      LEGACY_MENU_ACTIONS[0]!,
      SNOOZED_MENU_ACTIONS[1]!,
    ],
    [autoSettleMenuItems, titleMenuItems],
  );
  const legacyMenuActions = useMemo<MenuAction[]>(
    () => [
      LEGACY_MENU_ACTIONS[0]!,
      ...arrangementMenuItems,
      ...titleMenuItems,
      LEGACY_MENU_ACTIONS[1]!,
    ],
    [arrangementMenuItems, titleMenuItems],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Dialog.alert(
          "Could not snooze thread",
          "That snooze time has passed. Choose another time.",
        );
      }
    },
    [
      onNewThreadOnBranch,
      thread,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      setCustomSnoozeOpen,
      snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: `Archive ${thread.title}`,
        icon: "archivebox" as const,
        label: "Archive",
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: `Wake ${thread.title} now`,
        icon: "clock" as const,
        label: "Wake",
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: `Un-settle ${thread.title}`,
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: `Settle ${thread.title}`,
          icon: "checkmark" as const,
          label: "Settle",
          onPress: handleSettle,
        };
  }, [
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const swipeAccessibilityHint = !canOperateThread
    ? "Opens the thread"
    : secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;

  const detail = [
    thread.branch ?? props.projectTitle ?? props.project?.title,
    props.environmentLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const rowBody = (
    <View style={{ flex: 1, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          className={cn(
            "font-t3-medium",
            variant === "slim" ? rowColors.mutedForegroundClassName : rowColors.foregroundClassName,
          )}
          numberOfLines={1}
          style={{ flex: 1, fontSize: 15, lineHeight: 22 }}
        >
          {thread.title}
        </Text>
        {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
        {pinnedRow ? (
          <SymbolView
            name="pin"
            size={11}
            tintColorClassName={rowColors.mutedIconTintClassName}
            type="monochrome"
          />
        ) : null}
        <Text
          className={cn("tabular-nums", rowColors.mutedForegroundClassName)}
          style={{ fontSize: 12, lineHeight: 17 }}
        >
          {snoozedRow && props.snoozeWakeLabelText !== undefined
            ? props.snoozeWakeLabelText
            : props.timeLabel}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 26 }}>
        {pr ? (
          <SymbolView
            name={
              pr.kind === "stack"
                ? PullRequestGlyph.stack
                : pr.state === null
                  ? PullRequestGlyph.pullRequest
                  : pullRequestStatus({ state: pr.state, isDraft: pr.isDraft }).icon
            }
            size={14}
            tintColorClassName={
              pr.state === null || pr.isDraft
                ? rowColors.mutedIconTintClassName
                : pr.state === "open"
                  ? "accent-adaptive-emerald-600-400"
                  : pr.state === "closed"
                    ? "accent-adaptive-rose-600-400"
                    : "accent-adaptive-violet-600-400"
            }
          />
        ) : null}
        {/* The machine glyph hugs its label (it cannot live inside the Text
            without breaking truncation), and the wrapper takes the slack so
            the trailers stay pinned right. */}
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text
            className={
              failedError && !selected
                ? status === "limited"
                  ? "text-warning-foreground"
                  : "text-danger-foreground"
                : rowColors.mutedForegroundClassName
            }
            numberOfLines={1}
            style={{ flexShrink: 1, fontSize: 13, lineHeight: 19 }}
          >
            {failedError ?? detail}
          </Text>
          {!failedError && props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={11}
              tintColorClassName={rowColors.mutedIconTintClassName}
            />
          ) : null}
        </View>
        {pr ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={prBadgeLabel ?? undefined}
            // The number is ~13pt tall; reach 44pt vertically without moving
            // the layout. Left slop stays inside the 6pt gap so the end of a
            // long branch still opens the thread.
            hitSlop={{ top: 16, bottom: 16, left: 6, right: 8 }}
            onPress={(event) => {
              event.stopPropagation();
              handleOpenPullRequests();
            }}
            // Without a long-press handler a hold that opens the row's iOS
            // context menu would also open the pull request on release.
            onLongPress={() => undefined}
          >
            <Text className={rowColors.mutedForegroundClassName} style={{ fontSize: 11 }}>
              {pr.kind === "stack" || pr.others > 0 ? pr.label : `#${pr.label}`}
            </Text>
          </Pressable>
        ) : null}
        {props.agentThreads?.length ? (
          <ThreadAgentGroup
            threads={props.agentThreads}
            providers={props.providers}
            expanded={groupExpanded}
            canExpand={canExpandAgents}
            onToggle={toggleAgents}
            parentProjectId={thread.projectId}
          />
        ) : null}
        {showsWoke ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss Woke notification"
            hitSlop={{ top: 16, bottom: 16, left: 6, right: 8 }}
            onPress={(event) => {
              event.stopPropagation();
              handleAcknowledgeWoke();
            }}
            onLongPress={() => undefined}
            style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
          >
            <SymbolView
              name="bell.badge"
              size={11}
              tintColorClassName={
                selected ? rowColors.mutedIconTintClassName : "accent-warning-foreground"
              }
              type="monochrome"
            />
            <Text
              className={selected ? rowColors.foregroundClassName : "text-warning-foreground"}
              style={{ fontSize: 11 }}
            >
              Woke
            </Text>
          </Pressable>
        ) : statusLabel ? (
          <Text
            className={cn(
              (status === "working" || status === "waiting") && "tabular-nums",
              selected ? rowColors.foregroundClassName : statusLabel.className,
            )}
            style={{ fontSize: 11 }}
          >
            {statusLabel.label}
            {status === "working" ? (
              <ThreadListV2Duration startedAt={resolveThreadWorkingStartedAt(thread)} />
            ) : status === "waiting" ? (
              <ThreadListV2Duration startedAt={thread.latestRun?.completedAt ?? null} />
            ) : null}
          </Text>
        ) : null}
      </View>
      {props.searchMatch ? (
        <ThreadSearchMatchExcerpt
          sidebar={sidebarPane}
          match={props.searchMatch}
          query={props.searchQuery ?? ""}
          selected={selected}
        />
      ) : null}
    </View>
  );

  const accessibilityLabel = buildThreadRowAccessibilityLabel({
    title: thread.title,
    hasQueuedMessages: props.hasQueuedMessages === true,
    identityLabel: threadIdentityLabel(thread, {
      snoozed: snoozedRow,
      providerName: providerInstance?.displayName ?? null,
    }),
    failedError,
    snoozeWakeLabel: snoozedRow ? props.snoozeWakeLabelText : undefined,
  });
  const rowContent = (close: () => void) => (
    <RowPressable
      key={`${thread.environmentId}:${thread.id}`}
      interactionClassName={rowColors.interactionClassName}
      interactionOpacity={rowColors.interactionOpacity}
      accessibilityHint={
        swipeAccessibilityHint +
        (canOperateThread && props.pinningSupported ? " Swipe right to pin or unpin." : "")
      }
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected, ...(canExpandAgents ? { expanded: groupExpanded } : {}) }}
      accessibilityActions={rowAccessibilityActions}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "openPullRequests") handleOpenPullRequests();
        if (event.nativeEvent.actionName === "dismissWoke") handleAcknowledgeWoke();
        if (event.nativeEvent.actionName === "toggleAgents") toggleAgents();
      }}
      onPress={() => {
        close();
        onSelectThread(thread);
      }}
      style={{
        // Settled and snoozed rows keep both lines, so every row is one height:
        // the lines (22 + 5 gap + 26) and 20 padding fit the 74 minimum.
        minHeight: 74,
        marginHorizontal: sidebarPane ? 0 : 14,
        marginBottom: 4,
        padding: 10,
        paddingLeft: 10 + Math.min(props.hierarchyDepth ?? 0, 4) * 20,
        gap: 10,
        flexDirection: "row",
        alignItems: "center",
        borderRadius: THREAD_ROW_RADIUS,
        backgroundColor: rowColors.backgroundColor,
      }}
    >
      <ThreadAvatar
        thread={thread}
        // A child in its parent's project leads with its provider instead.
        project={props.parentProjectId === thread.projectId ? null : props.project}
        providerDriver={providerInstance?.driverKind ?? null}
        providerIconUrl={providerIconUrl}
        snoozed={snoozedRow}
      />
      {rowBody}
    </RowPressable>
  );

  const nested =
    props.agentThreads?.length && canExpandAgents && groupExpanded ? (
      <ExpandedThreadAgentRows
        parentProps={props}
        threads={props.agentThreads}
        onCollapse={() => setGroupExpanded(false)}
      />
    ) : null;

  if (!canOperateThread)
    return (
      <ThreadAvatarMotionContext value={!dormant}>
        <View
          style={sidebarPane ? { borderRadius: THREAD_ROW_RADIUS, overflow: "hidden" } : undefined}
        >
          {rowContent(() => {})}
        </View>
        {nested}
      </ThreadAvatarMotionContext>
    );

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      {/* Dormant rows sit outside the viewport; their working arcs hold still. */}
      <ThreadAvatarMotionContext value={!dormant}>
        <ThreadSwipeable
          dormant={dormant}
          threadKey={`${thread.environmentId}:${thread.id}`}
          backgroundColor={rowColors.swipeBackgroundColor}
          containerStyle={
            sidebarPane ? { borderRadius: THREAD_ROW_RADIUS, overflow: "hidden" } : undefined
          }
          enableTrackpadSwipe
          fullSwipeAction="primary"
          fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
          onDelete={handleDelete}
          onSwipeableClose={props.onSwipeableClose}
          onSwipeableWillOpen={props.onSwipeableWillOpen}
          primaryAction={primaryAction}
          secondaryAction={secondaryAction}
          resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}`}
          simultaneousWith={props.simultaneousSwipeGesture}
          threadTitle={thread.title}
        >
          {(close) => (
            <Menu
              actions={[
                ...(thread.branch
                  ? [
                      {
                        id: "new-thread-on-branch",
                        title: getThreadListV2NewBranchMenuTitle(thread.branch),
                        image: "square.and.pencil",
                      },
                    ]
                  : []),
                { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
                ...(snoozedRow
                  ? snoozedMenuActions
                  : !props.settlementSupported
                    ? legacyMenuActions
                    : canUnsettle
                      ? slimMenuActions
                      : swipeActions.secondary === "snooze"
                        ? snoozableCardMenuActions
                        : cardMenuActions),
              ]}
              onPressAction={handleMenuAction}
              shouldOpenOnLongPress
            >
              {rowContent(close)}
            </Menu>
          )}
        </ThreadSwipeable>
        {nested}
      </ThreadAvatarMotionContext>
    </View>
  );
});

/** The expanded group: a count line, then each unpinned child as a nested row. */
function ExpandedThreadAgentRows({
  parentProps,
  threads,
  onCollapse,
}: {
  readonly parentProps: ThreadListV2RowProps;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onCollapse: () => void;
}) {
  const hierarchy = useMemo(() => buildThreadAgentGroupHierarchy(threads), [threads]);
  const colors = useNavigationColors();
  const grandchildren = hierarchy.reduce((count, node) => count + node.children.length, 0);
  const deeperCount = threads.length - hierarchy.length - grandchildren;
  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft:
            (parentProps.pane === "sidebar" ? 12 : 26) +
            Math.min(parentProps.hierarchyDepth ?? 0, 4) * 20,
          paddingRight: 24,
        }}
      >
        <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: colors.muted }}>
          {hierarchy.length} {hierarchy.length === 1 ? "child session" : "child sessions"}
          {grandchildren ? ` · ${grandchildren} nested` : ""}
          {deeperCount ? ` · ${deeperCount} deeper` : ""}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Collapse child sessions under ${parentProps.thread.title}`}
          onPress={onCollapse}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={{ fontSize: 12, color: colors.muted }}>Collapse</Text>
        </Pressable>
      </View>
      {hierarchy
        .filter((node) => node.thread.pinnedAt == null)
        .map((node) => (
          <NestedThreadRow
            key={`${node.thread.environmentId}:${node.thread.id}`}
            parentProps={parentProps}
            node={node}
          />
        ))}
    </>
  );
}

function NestedThreadRow({
  parentProps,
  node,
}: {
  readonly parentProps: ThreadListV2RowProps;
  readonly node: ThreadAgentGroupNode;
}) {
  const thread = node.thread;
  const key = `${thread.environmentId}:${thread.id}`;
  const stamp = parentProps.agentRowStamps?.get(key);
  const project = useProject({ environmentId: thread.environmentId, projectId: thread.projectId });
  const descendants = useMemo(() => {
    const result: EnvironmentThreadShell[] = [];
    const visit = (child: ThreadAgentGroupNode) => {
      result.push(child.thread);
      child.children.forEach(visit);
    };
    node.children.forEach(visit);
    return result;
  }, [node]);
  return (
    <ThreadListV2Row
      {...parentProps}
      thread={thread}
      agentThreads={descendants}
      hierarchyDepth={(parentProps.hierarchyDepth ?? 0) + 1}
      parentProjectId={parentProps.thread.projectId}
      project={project}
      projectTitle={project?.title}
      // Children share their parent's environment, so its provider list applies.
      providerInstance={resolveThreadProviderInstance(parentProps.providers, thread)}
      selected={parentProps.selectedThreadKey === key}
      variant="card"
      pinned={false}
      snoozed={false}
      wokeAt={null}
      snoozeWakeLabelText={undefined}
      timeLabel={stamp?.timeLabel ?? ""}
      hasQueuedMessages={stamp?.hasQueuedMessages === true}
      snoozePresetMinute={stamp?.snoozePresetMinute ?? ""}
      canMoveUp={false}
      canMoveDown={false}
      reorderSupported={false}
      searchMatch={undefined}
    />
  );
}
