import type { ThreadListActions } from "../home/useThreadListActions";
import {
  PinnedSectionIcon,
  RecentIcon,
  SettledIcon,
  SnoozedIcon,
} from "../../components/NavigationIcons";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { getThreadRowColors } from "./thread-row-colors";
import { RowPressable } from "../../components/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { canSnooze, resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { MenuAction } from "@react-native-menu/menu";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Alert, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { ThreadSessionDetails } from "./ThreadSessionDetails";
import { ThreadAgentGroup } from "./ThreadAgentGroup";
import { ThreadPullRequestPicker } from "./ThreadPullRequestPicker";
import { SymbolView } from "../../components/AppSymbol";
import { ThreadActionSheet } from "./ThreadActionSheet";
import {
  ThreadAvatar,
  ThreadAvatarMotionContext,
  threadIdentityLabel,
} from "../../components/ThreadAvatar";
import { useNavigationColors } from "../../components/useNavigationColors";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import {
  resolveThreadProviderInstance,
  type ThreadRowProviderInstance,
} from "./thread-provider-instance";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  buildThreadAgentGroupHierarchy,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  type ThreadListV2AgentRowStamp,
  type ThreadListV2Status,
} from "./threadListV2";
import { useProject, useEnvironmentServerConfig } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { QueuedMessageIcon } from "./queued-message-icon";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * Thread List v2 renders one flat native list: rich edge-to-edge rows for
 * active work and a receded settled tail, all with native swipe and
 * long-press actions. State reads through colored status labels and text
 * hierarchy rather than card fills.
 */

// Status hues follow the system-wide convention set by sidebar v1 and the
// Live Activity/widgets (amber approval, indigo input, sky working) so a
// thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  "awaiting-parent": {
    label: "Waiting on parent",
    className: "text-foreground-secondary",
  },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  failed: { label: "Failed", className: "text-danger-foreground" },
};

// Menus keep lifecycle and title regeneration together. Archive keeps its
// own surface (thread screen / settings) rather than crowding v2 rows.
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

// Pre-settlement servers: no lifecycle items, archive fills the gap.
const LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/** Rounded-row radius shared by thread, queued and draft rows. */
const THREAD_ROW_RADIUS = 12;

/** Pinned/Recent group label. Icon + muted text only — no rule line, since
    this reads as a group heading rather than the collapsible shelves below. */
export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  const colors = useNavigationColors();
  const Icon = props.label === "Pinned" ? PinnedSectionIcon : RecentIcon;
  return (
    <View
      style={{
        minHeight: 28,
        marginBottom: 4,
        paddingHorizontal: props.pane === "sidebar" ? 10 : 24,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Icon size={14} color={colors.muted} />
      <Text style={{ fontSize: 13, color: colors.muted }}>{props.label}</Text>
    </View>
  );
});

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

/** Collapsible Snoozed/Settled shelf: a ruled header with its count. */
function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: "snoozed" | "settled" },
) {
  const colors = useNavigationColors();
  const Icon = props.kind === "snoozed" ? SnoozedIcon : SettledIcon;
  return (
    <Pressable
      accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`}
      accessibilityLabel={`${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={{
        minHeight: 48,
        marginHorizontal: props.pane === "sidebar" ? 6 : 20,
        marginTop: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Icon size={14} color={colors.muted} />
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>
        {props.kind === "snoozed" ? "Snoozed" : "Settled"}
      </Text>
      <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.count}</Text>
      <IconChevronRight
        size={14}
        color={colors.muted}
        style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
      />
    </Pressable>
  );
}

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

/**
 * Unsent work, in the same two-line idiom as a thread row: it is work the
 * user wrote, so it reads like the thread it will become. The status slot says
 * what happens next, not where the item sits: "Sends on reconnect" stays
 * uncolored because nothing is asked of the user; "Draft" takes the amber the
 * web sidebar uses for drafts, because this one waits on the user.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  /** Drawn beside the label; ignored while the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Unsent" divider above the first draft or queued row. */
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
      <ControlPillMenu
        actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityActions={[{ name: "delete", label: "Delete queued task" }]}
          accessibilityHint={
            isDraft
              ? "Opens the draft in the new task composer"
              : "Sends when the environment reconnects. Opens the task for editing"
          }
          accessibilityLabel={[pendingTask.title, "Queued", projectTitle, props.environmentLabel]
            .filter(Boolean)
            .join(", ")}
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
      </ControlPillMenu>
    </>
  );
});

interface ThreadListV2RowProps {
  readonly hierarchyDepth?: number;
  readonly parentProjectId?: EnvironmentThreadShell["projectId"];
  readonly selectedThreadKey?: string;
  readonly agentThreads?: ReadonlyArray<EnvironmentThreadShell>;
  /** Root row's per-descendant stamps (see ThreadListV2ThreadListItem),
      handed down unchanged so every nesting level reads its own entry. */
  readonly agentRowStamps?: ReadonlyMap<string, ThreadListV2AgentRowStamp>;
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Preformatted against the parent clock (row order timestamp: settle stamp
      on settled rows, latest activity otherwise). Blank while the wake
      countdown owns that slot. Precomputed per row — not via the list's
      extraData — so the minute tick re-renders only rows whose displayed
      text moved. */
  readonly timeLabel: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly providerInstance: ThreadRowProviderInstance | null;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Drawn after the label so the machine reads at a glance; ignored while
      the label is null. */
  readonly environmentMachine?: EnvironmentMachineKind;
  /** Hosting surface. "screen" (default) renders the compact Home list:
      rounded rows inset from the screen edge. "sidebar" renders the iPad
      split-view pane: full-width rounded rows on the drawer surface, with
      the thread open in the detail pane filled with the selection color. */
  readonly pane?: "screen" | "sidebar";
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onConfirmDeleteThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: ThreadListActions["renameThread"];
  readonly onRegenerateThreadTitle: ThreadListActions["regenerateThreadTitle"];
  readonly onSettleThread: ThreadListActions["settleThread"];
  readonly onSnoozeThread: ThreadListActions["snoozeThread"];
  readonly onUnsnoozeThread: ThreadListActions["unsnoozeThread"];
  readonly onUnsettleThread: ThreadListActions["unsettleThread"];
  readonly onArchiveThread: ThreadListActions["archiveThread"];
  readonly onPinThread: ThreadListActions["pinThread"];
  readonly onUnpinThread: ThreadListActions["unpinThread"];
  readonly onSetThreadAutoSettle: ThreadListActions["setThreadAutoSettle"];
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread.auto-settle.set. */
  readonly autoSettleOptOutSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** False on servers that predate thread.pin.reorder. Gates the pinned
      Move up / Move down menu items. */
  readonly pinReorderSupported?: boolean;
  readonly onMovePinnedThread?: ThreadListActions["movePinnedThread"];
  /** Server supports reordering this card's section. */
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  /** Position flags for the card's section so the menu disables the move that
      would fall off the end of the list. */
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  /** Position flags for the pinned block so the menu disables the move that
      would fall off the end of the list. */
  readonly canMovePinnedUp?: boolean;
  readonly canMovePinnedDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** List key checked against the Home swipe row activation. */
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  /** Parent minute tick carried on the row's list item, present only when the
      row's menu offers snooze presets, so those menus refresh while mounted
      without invalidating every other row. */
  readonly snoozePresetMinute: string;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}

export const ThreadListV2Row = memo(function ThreadListV2Row(props: ThreadListV2RowProps) {
  const { width: windowWidth } = useWindowDimensions();
  const rowFocusRef = useRef<View>(null);
  const [groupExpanded, setGroupExpanded] = useState(false);
  const [sheet, setSheet] = useState<"actions" | "snooze" | "details" | null>(null);
  useEffect(() => {
    setGroupExpanded(false);
    setSheet(null);
  }, [props.thread.environmentId, props.thread.id]);
  const canExpandAgents = useMemo(
    () =>
      buildThreadAgentGroupHierarchy(props.agentThreads ?? []).some(
        (node) => node.thread.pinnedAt == null,
      ),
    [props.agentThreads],
  );
  const toggleAgents = () => {
    if (canExpandAgents) setGroupExpanded((value) => !value);
    else setSheet("details");
  };
  const {
    thread,
    variant,
    onSelectThread,
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
    onMovePinnedThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const pr = useThreadPr(thread);
  const [prPickerOpen, setPrPickerOpen] = useState(false);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowColors = getThreadRowColors(theme, sidebarPane, selected);

  const status = resolveThreadListV2Status(thread);
  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  // The timestamp is precomputed on the list item (same stamps the settled
  // tail sorts by) so a minute tick only re-renders rows whose text moved.
  const timeLabel = props.timeLabel;

  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // A recycled cell reassigns this mounted row to a different thread without
  // remounting it, and the render closure stops running while list equality
  // says the item is unchanged — so any row-local UI state must be dismissed
  // when the identity under it changes. Without this, a custom snooze sheet
  // opened for one thread survives the thread's removal/reorder and its
  // submit snoozes whichever thread the cell was reassigned to. (ThreadSwipeable
  // enforces the same contract on the swipe layer with its resetKey.)
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil, { reportFailure: false }),
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
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  // Swipe: the v2 primary action is the lifecycle transition. Un-settling a
  // settled row keeps it active until new activity clears the user override.
  const canUnsettle = variant === "slim";
  const [snoozeGateTick, bumpSnoozeGateTick] = useState(0);
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: new Date().toISOString() })
    : null;
  useEffect(() => {
    if (snoozeGateExpiryMs === null) return;
    const delayMs = Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeGateTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateTick]);
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: new Date().toISOString() }),
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
  // Pinned cards keep the full lifecycle menu; only the pin item flips to
  // Unpin. (Settling a pinned thread clears the pin server-side; snoozing
  // hides the card until wake with the pin intact.)
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
  // A submenu with the current option checked, matching web. This is a
  // per-thread setting, not a lifecycle verb.
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
      ...CARD_MENU_ACTIONS.slice(1),
    ],
    [arrangementMenuItems, autoSettleMenuItems, titleMenuItems],
  );
  // Settled and snoozed rows keep the setting too, matching web where every
  // row shares one menu builder.
  const slimMenuActions = useMemo<MenuAction[]>(
    () => [
      SLIM_MENU_ACTIONS[0]!,
      ...arrangementMenuItems.filter(
        (action) => action.id !== "move-up" && action.id !== "move-down",
      ),
      ...titleMenuItems,
      ...autoSettleMenuItems,
      SLIM_MENU_ACTIONS[1]!,
    ],
    [arrangementMenuItems, autoSettleMenuItems, titleMenuItems],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () => [
      SNOOZED_MENU_ACTIONS[0]!,
      ...titleMenuItems,
      ...autoSettleMenuItems,
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
  const handleSheetAction = async (id: string): Promise<boolean> => {
    const options = { reportFailure: false };
    switch (id) {
      case "settle":
        return onSettleThread(thread, options);
      case "unsettle":
        return onUnsettleThread(thread, options);
      case "unsnooze":
        return onUnsnoozeThread(thread, options);
      case "pin":
        return onPinThread(thread, options);
      case "unpin":
        return onUnpinThread(thread, options);
      case "move-pin-up":
        return onMovePinnedThread?.(thread, "up", options) ?? false;
      case "move-pin-down":
        return onMovePinnedThread?.(thread, "down", options) ?? false;
      case "archive":
        return onArchiveThread(thread, options);
      case "regenerate-title":
        return onRegenerateThreadTitle(thread, options);
      case "delete":
        return props.onConfirmDeleteThread(thread);
      default:
        return false;
    }
  };
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
      if (nativeEvent.event === "delete") void props.onConfirmDeleteThread(thread);
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
        Alert.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
      }
    },
    [
      onNewThreadOnBranch,
      thread,
      handleArchive,
      props.onConfirmDeleteThread,
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
      snoozePresets,
      setCustomSnoozeOpen,
    ],
  );
  const primaryAction = useMemo(() => {
    // Pre-settlement server: archive is the swipe action, as in v1. (Slim
    // rows cannot occur here — unsupported environments never classify as
    // settled.)
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
  const secondaryAction =
    swipeActions.secondary === "snooze"
      ? {
          accessibilityLabel: `Choose when to snooze ${thread.title}`,
          icon: "zzz" as const,
          label: "Snooze",
          onPress: () => setSheet("snooze"),
        }
      : null;
  const swipeAccessibilityHint =
    secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;

  // Two lines beside the session avatar: title and time, then branch (or
  // project) · machine with the PR, agent group, account and status after it.
  // A failed session's last error takes the branch slot so the height holds.
  const failedError = status === "failed" ? (thread.session?.lastError ?? null) : null;
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
            : timeLabel}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 26 }}>
        {pr ? (
          <SymbolView
            name={pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
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
                ? "text-danger-foreground"
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
            accessibilityLabel={`Choose ${pr.accessibilityLabel}`}
            hitSlop={8}
            onPress={(event) => {
              event.stopPropagation();
              setPrPickerOpen(true);
            }}
          >
            <Text className={rowColors.mutedForegroundClassName} style={{ fontSize: 11 }}>
              {pr.kind === "stack" || pr.others > 0 ? pr.label : `#${pr.label}`}
            </Text>
          </Pressable>
        ) : null}
        {props.agentThreads?.length ? (
          <ThreadAgentGroup
            threads={props.agentThreads}
            expanded={groupExpanded}
            canExpand={canExpandAgents}
            onToggle={toggleAgents}
            onDetails={() => setSheet("details")}
            parentProjectId={thread.projectId}
          />
        ) : null}
        {/* The avatar's provider badge is too small for initials, so a thread
            on one of several accounts of the same provider names it here. */}
        {props.providerInstance?.showBadge ? (
          <ProviderInstanceIcon
            provider={props.providerInstance.driverKind}
            size={14}
            displayName={props.providerInstance.displayName}
            accentColor={props.providerInstance.accentColor}
            showBadge
            surfaceColor={rowColors.providerIconSurfaceColor}
          />
        ) : null}
        {statusLabel ? (
          <Text className={statusLabel.className} style={{ fontSize: 11 }}>
            {statusLabel.label}
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

  const rowAccessibilityActions = [
    { name: "activate", label: "Open conversation" },
    { name: "showActions", label: "Conversation actions" },
    { name: "showSessionDetails", label: "Session details" },
    ...(props.agentThreads?.length
      ? [
          {
            name: "toggleAgents",
            label: canExpandAgents
              ? groupExpanded
                ? "Collapse agent group"
                : "Expand agent group"
              : "Session details",
          },
        ]
      : []),
  ];
  const handleRowAccessibilityAction = (
    close: () => void,
    { nativeEvent }: { readonly nativeEvent: { readonly actionName: string } },
  ) => {
    close();
    if (nativeEvent.actionName === "showActions") setSheet("actions");
    else if (nativeEvent.actionName === "showSessionDetails") setSheet("details");
    else if (nativeEvent.actionName === "toggleAgents") toggleAgents();
    else if (nativeEvent.actionName === "activate") onSelectThread(thread);
  };
  const providerDriver = props.providerInstance?.driverKind ?? null;
  const rowContent = (close: () => void) => (
    <RowPressable
      ref={rowFocusRef}
      key={`${thread.environmentId}:${thread.id}`}
      interactionClassName={rowColors.interactionClassName}
      interactionOpacity={rowColors.interactionOpacity}
      accessibilityHint={
        swipeAccessibilityHint + (props.pinningSupported ? " Swipe right to pin or unpin." : "")
      }
      accessibilityLabel={[
        thread.title,
        props.hasQueuedMessages ? "messages queued to send" : null,
        threadIdentityLabel(thread, props.providerInstance?.displayName ?? null),
      ]
        .filter(Boolean)
        .join(". ")}
      accessibilityRole="button"
      accessibilityState={{ selected, ...(canExpandAgents ? { expanded: groupExpanded } : {}) }}
      accessibilityActions={rowAccessibilityActions}
      onAccessibilityAction={(event) => handleRowAccessibilityAction(close, event)}
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Session details for ${thread.title}`}
        hitSlop={6}
        onPress={(event) => {
          event.stopPropagation();
          close();
          setSheet("details");
        }}
      >
        {/* A child in its parent's project leads with its provider instead. */}
        <ThreadAvatar
          thread={thread}
          project={props.parentProjectId === thread.projectId ? null : props.project}
          providerDriver={providerDriver}
        />
      </Pressable>
      {rowBody}
    </RowPressable>
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
          // Full swipe commits the advertised lifecycle action (Settle /
          // Un-settle), never the secondary snooze action.
          fullSwipeAction="primary"
          fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
          onSwipeableClose={props.onSwipeableClose}
          onSwipeableWillOpen={props.onSwipeableWillOpen}
          leadingAction={
            props.pinningSupported
              ? {
                  accessibilityLabel: `${thread.pinnedAt != null ? "Unpin" : "Pin"} ${thread.title}`,
                  label: thread.pinnedAt != null ? "Unpin" : "Pin",
                  icon: thread.pinnedAt != null ? "pin.slash" : "pin",
                  onPress: thread.pinnedAt != null ? handleUnpin : handlePin,
                }
              : undefined
          }
          primaryAction={primaryAction}
          secondaryAction={secondaryAction}
          resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}`}
          simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
          threadTitle={thread.title}
        >
          {(close) => (
            <ControlPillMenu
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
            </ControlPillMenu>
          )}
        </ThreadSwipeable>
      </ThreadAvatarMotionContext>
      {props.agentThreads?.length && canExpandAgents && groupExpanded ? (
        <ExpandedThreadAgentRows
          parentProps={props}
          threads={props.agentThreads}
          onCollapse={() => setGroupExpanded(false)}
        />
      ) : null}
      {sheet === "details" ? (
        <ThreadSessionDetails
          thread={thread}
          descendants={props.agentThreads ?? []}
          project={props.project}
          providerDriver={providerDriver}
          returnFocusRef={rowFocusRef}
          onClose={() => setSheet(null)}
          onSelect={onSelectThread}
        />
      ) : sheet ? (
        <ThreadActionSheet
          returnFocusRef={rowFocusRef}
          thread={thread}
          project={props.project}
          providerDriver={providerDriver}
          initialPage={sheet}
          onClose={() => setSheet(null)}
          onView={() => onSelectThread(thread)}
          onDelete={() => props.onConfirmDeleteThread(thread)}
          onSnooze={handleSnooze}
          onAction={handleSheetAction}
          actions={
            snoozedRow
              ? snoozedMenuActions
              : !props.settlementSupported
                ? legacyMenuActions
                : canUnsettle
                  ? slimMenuActions
                  : swipeActions.secondary === "snooze"
                    ? snoozableCardMenuActions
                    : cardMenuActions
          }
        />
      ) : null}
      {prPickerOpen && pr ? (
        <ThreadPullRequestPicker
          thread={thread}
          presentation={pr}
          returnFocusRef={rowFocusRef}
          onClose={() => setPrPickerOpen(false)}
        />
      ) : null}
    </View>
  );
});

function ExpandedThreadAgentRows({
  parentProps,
  threads,
  onCollapse,
}: {
  parentProps: ThreadListV2RowProps;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onCollapse: () => void;
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
          {hierarchy.length} {hierarchy.length === 1 ? "child" : "children"}
          {grandchildren
            ? ` · ${grandchildren} ${grandchildren === 1 ? "grandchild" : "grandchildren"}`
            : ""}
          {deeperCount ? ` · ${deeperCount} deeper` : ""}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Collapse agents under ${parentProps.thread.title}`}
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
            key={scopedThreadKey(node.thread.environmentId, node.thread.id)}
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
  parentProps: ThreadListV2RowProps;
  node: ReturnType<typeof buildThreadAgentGroupHierarchy>[number];
}) {
  const thread = node.thread;
  const stamp = parentProps.agentRowStamps?.get(`${thread.environmentId}:${thread.id}`);
  const project = useProject({ environmentId: thread.environmentId, projectId: thread.projectId });
  const config = useEnvironmentServerConfig(thread.environmentId);
  const descendants = useMemo(() => {
    const result: EnvironmentThreadShell[] = [];
    const visit = (child: typeof node) => {
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
      providerInstance={
        config
          ? resolveThreadProviderInstance(new Map([[thread.environmentId, config]]), thread)
          : null
      }
      selected={parentProps.selectedThreadKey === scopedThreadKey(thread.environmentId, thread.id)}
      pinned={thread.pinnedAt != null}
      snoozed={false}
      snoozeWakeLabelText={undefined}
      timeLabel={stamp?.timeLabel ?? ""}
      hasQueuedMessages={stamp?.hasQueuedMessages === true}
      snoozePresetMinute={stamp?.snoozePresetMinute ?? ""}
      canMoveUp={false}
      canMoveDown={false}
      searchMatch={undefined}
    />
  );
}
