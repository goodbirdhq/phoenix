import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Pressable, View, type PressableProps } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../lib/cn";
import { createPressFeedback } from "../lib/pressFeedback";
import { useHoverGesture } from "../lib/useHoverGesture";

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
  // Not Pressable's `pressed`: see createPressFeedback. The touch starts the
  // wait; raw touch end and cancel end it, and so does onPressOut, which is
  // how Pressability reports losing the responder to a scroll (the iOS
  // ScrollView sends no touch cancel) or the finger leaving the retention rect.
  const [pressed, setPressed] = useState(false);
  const feedback = useMemo(() => createPressFeedback(setPressed), []);
  useEffect(() => () => feedback.end(), [feedback]);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable
        {...props}
        className={cn("relative overflow-hidden", className)}
        onTouchStart={(event) => {
          feedback.touchDown();
          props.onTouchStart?.(event);
        }}
        onTouchEnd={(event) => {
          feedback.end();
          props.onTouchEnd?.(event);
        }}
        onTouchCancel={(event) => {
          feedback.end();
          props.onTouchCancel?.(event);
        }}
        onPressOut={(event) => {
          feedback.end();
          props.onPressOut?.(event);
        }}
      >
        {() => (
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
