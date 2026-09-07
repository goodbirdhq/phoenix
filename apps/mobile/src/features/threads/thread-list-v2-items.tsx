import {
  PinnedSectionIcon,
  RecentIcon,
  SnoozedIcon,
  SettledIcon,
} from "../../components/NavigationIcons";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
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
import { Alert, Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { ThreadAgentGroup } from "./ThreadAgentGroup";
import { ThreadActionSheet } from "./ThreadActionSheet";
import { ThreadAvatar } from "../../components/ThreadAvatar";
import { useNavigationColors } from "../../components/useNavigationColors";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr } from "../../state/use-thread-pr";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Status,
} from "./threadListV2";
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
  approval: { label: "Approval", className: "text-adaptive-amber-700-300" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  "awaiting-parent": {
    label: "Waiting on parent",
    className: "text-adaptive-indigo-600-300",
  },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  failed: { label: "Failed", className: "text-adaptive-red-700-300" },
};

function threadTimeLabel(thread: EnvironmentThreadShell): string {
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

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

/** Rounded-row radius shared with the v1 sidebar rows. */
const SIDEBAR_V2_ROW_RADIUS = 12;

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
function ShelfHeader(props: {
  count: number;
  disabled?: boolean;
  expanded: boolean;
  onToggle: () => void;
  pane?: "screen" | "sidebar";
  kind: "Snoozed" | "Settled";
}) {
  const colors = useNavigationColors();
  const Icon = props.kind === "Snoozed" ? SnoozedIcon : SettledIcon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.kind}, ${props.count}`}
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
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{props.kind}</Text>
      <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.count}</Text>
      <IconChevronRight
        size={14}
        color={colors.muted}
        style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
      />
    </Pressable>
  );
}
type ShelfProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};
export const ThreadListV2SnoozedShelfHeader = memo((props: ShelfProps) => (
  <ShelfHeader {...props} kind="Snoozed" />
));
export const ThreadListV2SettledShelfHeader = memo((props: ShelfProps) => (
  <ShelfHeader {...props} kind="Settled" />
));

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/**
 * A queued new task, in the same idiom as an active v2 row: it is work the
 * user wrote, so it reads like the threads it will become. "Queued" takes
 * the status slot — the state is the one thing that differs — and stays
 * uncolored because nothing is asked of the user; the environment is simply
 * not reachable yet.
 */
export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly environmentLabel: string | null;
  readonly pane?: "screen" | "sidebar";
  /** Draws the "Pending" divider above the first queued row. */
  readonly showPendingDivider: boolean;
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const colors = useNavigationColors();
  const pressedBackgroundColor = colors.selected;
  const drawerColor = colors.screen;
  const sidebarPane = props.pane === "sidebar";
  const projectTitle =
    props.projectTitle ?? props.project?.title ?? pendingTask.creation.projectTitle ?? "";
  const branch = pendingTask.creation.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const rowContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {props.project ? (
          <ProjectFavicon
            environmentId={pendingTask.message.environmentId}
            faviconPath={props.project.faviconPath}
            size={15}
            projectTitle={projectTitle}
            workspaceRoot={props.project.workspaceRoot}
          />
        ) : null}
        <Text className="flex-1 text-sm font-t3-medium text-foreground-muted" numberOfLines={1}>
          {projectTitle}
        </Text>
        <Text className="text-xs text-foreground-tertiary">Queued</Text>
      </View>
      {/* One line, unlike the two an active row allows: a queued title is
          derived from the whole prompt rather than written as a title, so the
          second line is usually a stray word or emoji rather than meaning. */}
      <Text className="mt-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {pendingTask.title}
      </Text>
      {branch || props.environmentLabel ? (
        <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
          {branch ? (
            <Text
              className="text-xs text-foreground-muted"
              style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}
            >
              {branch}
            </Text>
          ) : null}
          {branch && props.environmentLabel ? "  ·  " : null}
          {props.environmentLabel ? (
            <Text className="text-xs text-foreground-tertiary">{props.environmentLabel}</Text>
          ) : null}
        </Text>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider label="Pending" pane={props.pane} />
      ) : null}
      <ControlPillMenu
        actions={PENDING_TASK_MENU_ACTIONS}
        onPressAction={handleMenuAction}
        shouldOpenOnLongPress
      >
        <Pressable
          accessibilityHint="Opens the queued task for editing"
          accessibilityLabel={pendingTask.title}
          accessibilityRole="button"
          onPress={() => onSelectPendingTask(pendingTask)}
          style={
            sidebarPane
              ? ({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackgroundColor : drawerColor,
                  borderRadius: SIDEBAR_V2_ROW_RADIUS,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                })
              : ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
          }
        >
          {sidebarPane ? (
            rowContent
          ) : (
            <View className="bg-screen">
              <View className="px-5 py-2.5">{rowContent}</View>
              {props.showTrailingDivider !== false ? (
                <View className="ml-5 h-px bg-border-subtle" />
              ) : null}
            </View>
          )}
        </Pressable>
      </ControlPillMenu>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly agentThreads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  /** Pinned-block row: shows the pin glyph and offers Unpin. */
  readonly pinned?: boolean;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Parent minute tick passed as a prop so this memoized row refreshes its
      native snooze menu while mounted. */
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly projectTitle?: string;
  readonly providerDriver: string | null;
  /** Which machine hosts the thread. Null when only one environment is
      connected — repeating the same label on every row is noise. Mirrors
      the web sidebar's remote-environment cloud icon, but as text since
      phones have no hover tooltips. */
  readonly environmentLabel: string | null;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color —
      matching the v1 sidebar rows. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). The
      compact Home list never sets it — phones navigate away on select. */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onConfirmDeleteThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => void | Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
    options?: { reportFailure?: boolean },
  ) => void | Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void | Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void | Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void | Promise<boolean>;
  /** False on environments whose server predates thread.settle/unsettle:
      swipe + menu fall back to Archive instead of failing on use. */
  readonly settlementSupported: boolean;
  /** False on servers that predate thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** False on servers that predate thread.pin/unpin. */
  readonly pinningSupported: boolean;
  /** False on servers that predate thread title regeneration. */
  readonly titleRegenerationSupported: boolean;
  /** False on servers that predate thread.pin.reorder. Gates the pinned
      Move up / Move down menu items. */
  readonly pinReorderSupported?: boolean;
  readonly onMovePinnedThread?: (thread: EnvironmentThreadShell, direction: "up" | "down") => void;
  /** Position flags for the pinned block so the menu disables the move that
      would fall off the end of the list. */
  readonly canMovePinnedUp?: boolean;
  readonly canMovePinnedDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly projectCwd?: string | null;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const rowFocusRef = useRef<View>(null);
  const [groupExpanded, setGroupExpanded] = useState(false);
  const [sheet, setSheet] = useState<"actions" | "snooze" | null>(null);
  useEffect(() => {
    setGroupExpanded(false);
    setSheet(null);
  }, [props.thread.environmentId, props.thread.id]);
  const colors = useNavigationColors();
  const {
    thread,
    variant,
    onSelectThread,
    onDeleteThread,
    onRegenerateThreadTitle,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onMovePinnedThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;

  const pr = useThreadPr(thread, props.projectCwd ?? props.project?.workspaceRoot ?? null);

  const screenColor = colors.screen;
  const drawerColor = colors.screen;
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;

  const status = resolveThreadListV2Status(thread);
  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  const timeLabel = threadTimeLabel(thread);

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil, { reportFailure: false }),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleMovePinnedUp = useCallback(
    () => onMovePinnedThread?.(thread, "up"),
    [onMovePinnedThread, thread],
  );
  const handleMovePinnedDown = useCallback(
    () => onMovePinnedThread?.(thread, "down"),
    [onMovePinnedThread, thread],
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
    () =>
      snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
    [snoozePresets],
  );
  // Pinned cards keep the full lifecycle menu; only the pin item flips to
  // Unpin. (Settling a pinned thread clears the pin server-side; snoozing
  // hides the card until wake with the pin intact.)
  const pinMenuItem = useMemo<MenuAction[]>(
    () =>
      props.pinningSupported
        ? [
            ...(pinnedRow && props.pinReorderSupported === true
              ? [
                  {
                    id: "move-pin-up",
                    title: "Move up",
                    image: "arrow.up",
                    attributes: { disabled: props.canMovePinnedUp !== true },
                  } satisfies MenuAction,
                  {
                    id: "move-pin-down",
                    title: "Move down",
                    image: "arrow.down",
                    attributes: { disabled: props.canMovePinnedDown !== true },
                  } satisfies MenuAction,
                ]
              : []),
            thread.pinnedAt != null
              ? { id: "unpin", title: "Unpin", image: "pin.slash" }
              : { id: "pin", title: "Pin", image: "pin" },
          ]
        : [],
    [
      pinnedRow,
      props.canMovePinnedDown,
      props.canMovePinnedUp,
      props.pinReorderSupported,
      props.pinningSupported,
      thread.pinnedAt,
    ],
  );
  const titleRegenerationMenuItems = useMemo<MenuAction[]>(
    () =>
      buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
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
      ...pinMenuItem,
      ...titleRegenerationMenuItems,
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
    [pinMenuItem, snoozePresetActions, titleRegenerationMenuItems],
  );
  const cardMenuActions = useMemo<MenuAction[]>(
    () => [
      CARD_MENU_ACTIONS[0]!,
      ...pinMenuItem,
      ...titleRegenerationMenuItems,
      ...CARD_MENU_ACTIONS.slice(1),
    ],
    [pinMenuItem, titleRegenerationMenuItems],
  );
  const slimMenuActions = useMemo<MenuAction[]>(
    () => [
      SLIM_MENU_ACTIONS[0]!,
      ...(thread.pinnedAt != null ? pinMenuItem : []),
      ...titleRegenerationMenuItems,
      SLIM_MENU_ACTIONS[1]!,
    ],
    [pinMenuItem, thread.pinnedAt, titleRegenerationMenuItems],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () => [SNOOZED_MENU_ACTIONS[0]!, ...titleRegenerationMenuItems, SNOOZED_MENU_ACTIONS[1]!],
    [titleRegenerationMenuItems],
  );
  const legacyMenuActions = useMemo<MenuAction[]>(
    () => [LEGACY_MENU_ACTIONS[0]!, ...titleRegenerationMenuItems, LEGACY_MENU_ACTIONS[1]!],
    [titleRegenerationMenuItems],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "move-pin-up") handleMovePinnedUp();
      if (nativeEvent.event === "move-pin-down") handleMovePinnedDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "delete") handleDelete();
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
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleMovePinnedDown,
      handleMovePinnedUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      snoozePresets,
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

  // The sidebar pane fills selected rows with the theme's message surface, so
  // every piece of row text must use that surface's paired foreground.
  const rowContent = (close: () => void) => (
    <Pressable
      ref={rowFocusRef}
      accessibilityHint={
        swipeAccessibilityHint + (props.pinningSupported ? " Swipe right to pin or unpin." : "")
      }
      accessibilityLabel={thread.title}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onLongPress={() => {
        close();
        setSheet("actions");
      }}
      onPress={() => {
        close();
        onSelectThread(thread);
      }}
      style={({ pressed }) => ({
        minHeight: variant === "slim" ? 56 : 74,
        marginHorizontal: sidebarPane ? 0 : 14,
        marginBottom: 4,
        padding: 10,
        gap: 10,
        flexDirection: "row",
        alignItems: "center",
        borderRadius: 12,
        backgroundColor: selected || pressed ? colors.selected : colors.screen,
      })}
    >
      <ThreadAvatar thread={thread} project={props.project} providerDriver={props.providerDriver} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: 16,
              lineHeight: 23,
              color: variant === "slim" ? colors.muted : colors.foreground,
            }}
          >
            {thread.title}
          </Text>
          <Text style={{ fontSize: 11, color: colors.muted }}>
            {snoozedRow ? props.snoozeWakeLabelText : timeLabel}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {pr ? (
            <IconGitPullRequest size={14} color={pr.state === "open" ? "#047857" : colors.muted} />
          ) : null}
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 13, lineHeight: 19, color: colors.muted }}
          >
            {[thread.branch ?? props.projectTitle ?? props.project?.title, props.environmentLabel]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {pr ? (
            <Text
              accessibilityLabel={pr.accessibilityLabel}
              style={{ fontSize: 11, color: colors.muted }}
            >
              #{pr.label}
            </Text>
          ) : null}
          {props.agentThreads?.length ? (
            <ThreadAgentGroup
              threads={props.agentThreads}
              expanded={groupExpanded}
              onToggle={() => setGroupExpanded((value) => !value)}
              onSelect={onSelectThread}
            />
          ) : null}
          {statusLabel ? (
            <Text className={statusLabel.className} style={{ fontSize: 11 }}>
              {statusLabel.label}
            </Text>
          ) : null}
        </View>
        {status === "failed" && thread.session?.lastError ? (
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.danger }}>
            {thread.session.lastError}
          </Text>
        ) : null}
        {props.searchMatch ? (
          <ThreadSearchMatchExcerpt
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        ) : null}
      </View>
    </Pressable>
  );

  return (
    <>
      <ThreadSwipeable
        backgroundColor={sidebarPane ? drawerColor : screenColor}
        compactActions={variant === "slim"}
        containerStyle={
          sidebarPane ? { borderRadius: SIDEBAR_V2_ROW_RADIUS, overflow: "hidden" } : undefined
        }
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        onDelete={handleDelete}
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
        resetKey={`${thread.environmentId}:${thread.id}`}
        simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => rowContent(close)}
      </ThreadSwipeable>
      {props.agentThreads?.length && groupExpanded ? (
        <View
          style={{
            marginLeft: sidebarPane ? 44 : 58,
            marginRight: sidebarPane ? 0 : 14,
            marginBottom: 8,
          }}
        >
          <ThreadAgentGroup
            threads={props.agentThreads}
            expanded={groupExpanded}
            onToggle={() => setGroupExpanded(false)}
            onSelect={onSelectThread}
            detail
          />
        </View>
      ) : null}
      {sheet ? (
        <ThreadActionSheet
          returnFocusRef={rowFocusRef}
          thread={thread}
          project={props.project}
          providerDriver={props.providerDriver}
          initialPage={sheet}
          onClose={() => setSheet(null)}
          onView={() => onSelectThread(thread)}
          onDelete={() => props.onConfirmDeleteThread(thread)}
          onSnooze={handleSnooze}
          onAction={(id) => handleMenuAction({ nativeEvent: { event: id } })}
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
    </>
  );
});
