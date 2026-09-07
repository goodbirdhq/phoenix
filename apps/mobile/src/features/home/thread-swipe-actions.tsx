import { SettleIcon, SnoozeIcon, PinIcon, UnpinIcon } from "../../components/NavigationIcons";
import { useNavigationColors } from "../../components/useNavigationColors";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  ColorValue,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { View } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

// Wide enough for the longest action label ("Unarchive").
const ACTION_ITEM_WIDTH = 74;

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly backgroundColor: string;
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

/** `undefined` keeps the v1 Delete default; `null` means one action only. */
function resolveSecondaryAction(input: {
  readonly close: () => void;
  readonly onDelete: () => void;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly threadTitle: string;
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null;
  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: `Delete ${input.threadTitle}`,
      backgroundColor: "#ff2d55",
      icon: "trash",
      label: "Delete",
      onPress: () => {
        input.close();
        input.onDelete();
      },
    };
  }
  const action = input.secondaryAction;
  return {
    ...action,
    backgroundColor: "#71717a",
    menu:
      action.menu === undefined
        ? undefined
        : {
            ...action.menu,
            onPressAction: (event) => {
              input.close();
              action.menu?.onPressAction(event);
            },
          },
    onPress: () => {
      input.close();
      action.onPress();
    },
  };
}

/**
 * Delivers the scroll gate to swipeables via context so that flipping it does
 * NOT re-render whole rows: putting the flag in list extraData/renderItem deps
 * re-rendered every visible row (hooks, subscriptions and all) exactly at
 * scroll start — peak frame pressure. As a context value only the
 * ThreadSwipeable consumers re-render.
 */
const SwipeableScrollGateContext = createContext(true);

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      {props.children}
    </SwipeableScrollGateContext.Provider>
  );
}

/**
 * Gates row swipes on list scroll activity, mirroring UIKit's own swipe
 * actions (`!isDragging && !isDecelerating`). failOffsetY on the swipe pan
 * covers the first pan of a scroll, but trackpad scroll sessions spawn fresh
 * gesture sessions (momentum catch, direction changes) whose reset
 * translation can re-activate a swipe mid-scroll — so while the list has
 * moved vertically during an active drag/momentum phase, row swipes are
 * disabled entirely.
 *
 * Spread the returned handlers onto the list and pass `swipeEnabled` to rows.
 */
export function useSwipeableScrollGate(options?: {
  readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalOnScroll = options?.onScroll;
  const externalOnScrollBeginDrag = options?.onScrollBeginDrag;

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next;
      setGateActive(next);
    }
  }, []);
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearSettle, [clearSettle]);

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      dragStartYRef.current = event.nativeEvent.contentOffset.y;
      clearSettle();
      externalOnScrollBeginDrag?.(event);
    },
    [clearSettle, externalOnScrollBeginDrag],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Only vertical movement during a user drag arms the gate — a purely
      // horizontal row swipe never moves contentOffset.y, and inset-driven
      // offset changes at mount happen outside a drag.
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true);
      }
      externalOnScroll?.(event);
    },
    [externalOnScroll, update],
  );
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
    clearSettle();
    // If momentum follows, onMomentumScrollBegin cancels this and the gate
    // stays armed until the deceleration finishes.
    settleTimerRef.current = setTimeout(() => update(false), 160);
  }, [clearSettle, update]);
  const onMomentumScrollBegin = useCallback(() => {
    clearSettle();
  }, [clearSettle]);
  const onMomentumScrollEnd = useCallback(() => {
    update(false);
  }, [update]);

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  /** Uses action visuals that fit inside compact 44pt rows. The press target
   * still spans the row's full height and width. */
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  /** Disables NEW swipe activations (e.g. while the list scrolls). */
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /**
   * What a full swipe commits. Omitted keeps the v1 Delete behavior only when
   * the built-in Delete secondary action is in use; custom or absent
   * secondary actions default to the advertised primary action.
   */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly leadingAction?: ThreadSwipeAction;
  readonly primaryAction: ThreadSwipeAction;
  /**
   * Omitted keeps the v1 destructive Delete action. Explicit null opts out of
   * a secondary action entirely so a gated Snooze can never fall back to an
   * unadvertised Delete.
   */
  readonly secondaryAction?: ThreadSwipeAction | null;
  /**
   * Identity of the content being wrapped. When a recycled list reuses this
   * component for a different item, the swipeable snaps back to closed so an
   * open/mid-drag state can't leak onto another row.
   */
  readonly resetKey?: string;
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >["simultaneousWithExternalGesture"];
  readonly threadTitle: string;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const resetKey = props.resetKey;
  useEffect(() => {
    if (resetKey === undefined) {
      return;
    }
    fullSwipeArmedRef.current = false;
    swipeableRef.current?.reset();
  }, [resetKey]);
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      dragOffsetFromRightEdge={8}
      enabled={props.enabled !== false && gateEnabled}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      // Fail the swipe once the pan is vertically dominant (patched-in RNGH
      // prop) — otherwise trackpad scrolls with ~8px of horizontal drift
      // start opening rows because the swipe pan runs simultaneously with
      // the list scroll gesture and never gets disqualified by Y movement.
      failOffsetY={[-10, 10]}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose?.(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen?.(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;
        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen?.(methods);
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          if (fullSwipeAction === "primary") {
            props.primaryAction.onPress();
          } else {
            props.onDelete();
          }
        }
      }}
      overshootFriction={1}
      overshootRight
      overshootLeft={false}
      leftThreshold={36}
      renderLeftActions={
        props.leadingAction
          ? (_progress, _translation, methods) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.leadingAction?.accessibilityLabel}
                onPress={() => {
                  methods.close();
                  props.leadingAction?.onPress();
                }}
                style={{
                  width: 88,
                  height: "100%",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "#0284c7",
                  borderTopRightRadius: 12,
                  borderBottomRightRadius: 12,
                }}
              >
                <SwipeIcon name={props.leadingAction!.icon} />
              </Pressable>
            )
          : undefined
      }
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          compact={props.compactActions === true}
          fullSwipeAction={fullSwipeAction}
          fullSwipeThreshold={fullSwipeThreshold}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close();
              props.primaryAction.onPress();
            },
          }}
          secondaryAction={resolveSecondaryAction({
            close: () => methods.close(),
            onDelete: props.onDelete,
            secondaryAction: props.secondaryAction,
            threadTitle: props.threadTitle,
          })}
          translation={translation}
        />
      )}
      rightThreshold={actionsWidth * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly backgroundColor: string;
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: ThreadSwipeAction["menu"];
  readonly onPress: () => void;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const actionStyle = useAnimatedStyle(() => {
    const stretch = props.stretchesOnFullSwipe
      ? Math.max(-props.translation.value - props.actionsWidth, 0)
      : 0;
    return { width: ACTION_ITEM_WIDTH + stretch, transform: [{ translateX: -stretch }] };
  });
  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        height: "100%",
        width: "100%",
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.72 : 1,
      })}
    >
      <SwipeIcon name={props.icon} />
    </Pressable>
  );
  return (
    <Animated.View
      style={[
        {
          height: "100%",
          backgroundColor: props.backgroundColor,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu ? (
        <ControlPillMenu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </ControlPillMenu>
      ) : (
        button
      )}
    </Animated.View>
  );
}

function SwipeIcon({ name }: { name: ComponentProps<typeof SymbolView>["name"] }) {
  const Icon =
    name === "checkmark"
      ? SettleIcon
      : name === "zzz"
        ? SnoozeIcon
        : name === "pin"
          ? PinIcon
          : name === "pin.slash"
            ? UnpinIcon
            : null;
  return Icon ? (
    <Icon size={24} color="#ffffff" />
  ) : (
    <SymbolView name={name} size={24} tintColor="#ffffff" type="monochrome" />
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly secondaryAction: ThreadSwipeSecondaryAction | null;
  readonly translation: SharedValue<number>;
}) {
  const { fullSwipeThreshold, onFullSwipeArmedChange, secondaryAction, translation } = props;
  const colors = useNavigationColors();
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary" || secondaryAction === null;
  const actionsWidth = swipeActionsWidth(secondaryAction !== null);
  useAnimatedReaction(
    () => -translation.value >= fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(onFullSwipeArmedChange)(armed);
      }
    },
    [fullSwipeThreshold, onFullSwipeArmedChange, translation],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
        borderTopLeftRadius: 12,
        borderBottomLeftRadius: 12,
        overflow: "hidden",
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        backgroundColor="#0284c7"
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          backgroundColor={
            secondaryAction.label === "Snooze" ? colors.snooze : secondaryAction.backgroundColor
          }
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  );
}
