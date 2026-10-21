import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { cn } from "../../lib/cn";
import { createPressFeedback } from "../../lib/pressFeedback";
import { useHoverGesture } from "../../lib/useHoverGesture";

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
  // Not Pressable's `pressed`, which lights on release for quick taps and can
  // outlive a scroll start; see createPressFeedback. A touch that a nested
  // pressable owns never reaches the row's press-in, so it never arms.
  const [pressed, setPressed] = useState(false);
  const feedback = useMemo(() => createPressFeedback(setPressed), []);
  useEffect(() => () => feedback.end(), [feedback]);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable
        {...props}
        className={cn("relative overflow-hidden", className)}
        onPressIn={(event) => {
          feedback.pressIn();
          props.onPressIn?.(event);
        }}
        onPress={(event) => {
          feedback.press();
          props.onPress?.(event);
        }}
        onPressOut={(event) => {
          feedback.pressOut();
          props.onPressOut?.(event);
        }}
      >
        {() => (
          <>
            <View
              pointerEvents="none"
              className={cn("absolute inset-0", interactionClassName)}
              style={{ opacity: props.disabled || !(hovered || pressed) ? 0 : interactionOpacity }}
            />
            {children}
          </>
        )}
      </Pressable>
    </GestureDetector>
  );
}
