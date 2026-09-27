import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Pressable, View, type PressableProps } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../lib/cn";
import { useHoverGesture } from "../lib/useHoverGesture";

// A touch that starts a scroll or swipe is cancelled within this window, so
// the fill only appears for a finger that stays on the row.
const ROW_PRESS_DELAY_MS = 120;

const RowLongPressContext = createContext<PressableProps["onLongPress"]>(undefined);

/**
 * The row's own long-press handler, for nested pressables that would otherwise
 * swallow the hold (Android injects the row menu's opener as onLongPress).
 */
export function useRowLongPress() {
  return useContext(RowLongPressContext);
}

/** Pointer feedback layered over selection. Touch-down may be the start of a scroll. */
export function RowPressable({
  children,
  className,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
}) {
  const { hovered, hoverGesture } = useHoverGesture(props.disabled ?? false);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable
        unstable_pressDelay={ROW_PRESS_DELAY_MS}
        {...props}
        className={cn("relative overflow-hidden", className)}
      >
        {({ pressed }) => (
          <>
            <View
              pointerEvents="none"
              className={cn("absolute inset-0", interactionClassName)}
              style={{
                opacity: props.disabled || !(hovered || pressed) ? 0 : interactionOpacity,
              }}
            />
            <RowLongPressContext value={props.onLongPress}>{children}</RowLongPressContext>
          </>
        )}
      </Pressable>
    </GestureDetector>
  );
}
