import { Platform, Pressable, ScrollView, View } from "react-native";
import Animated, { Easing, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { MaterialSegmentedControl } from "./MaterialSegmentedControl";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value> & { readonly scrollable?: boolean },
) {
  const compact = props.size === "compact";
  if (Platform.OS === "android") {
    return <MaterialSegmentedControl {...props} />;
  }
  const control = (
    <View
      accessible={false}
      className={cn(
        "flex-row overflow-hidden",
        "rounded-full border-continuous bg-card",
        props.scrollable ? undefined : props.className,
      )}
    >
      {props.scrollable ? null : (
        <Animated.View
          pointerEvents="none"
          layout={LinearTransition.duration(200)
            .easing(Easing.out(Easing.cubic))
            .reduceMotion(ReduceMotion.System)}
          className="absolute inset-y-0 rounded-full bg-secondary"
          style={{
            width: `${100 / props.options.length}%`,
            start: `${
              (Math.max(
                0,
                props.options.findIndex((option) => option.value === props.selected),
              ) *
                100) /
              props.options.length
            }%`,
          }}
        />
      )}
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={Platform.OS === "ios" ? "button" : (props.role ?? "button")}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            style={props.scrollable ? { flex: 0, paddingHorizontal: 16 } : undefined}
            className={cn(
              "items-center justify-center rounded-full",
              props.scrollable ? active && "bg-subtle-strong" : "flex-1",
              compact ? "h-9" : "h-11",
            )}
          >
            <Text
              className={cn(
                compact ? "text-xs" : "text-sm",
                active ? "font-t3-medium text-secondary-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return props.scrollable ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className={props.className}>
      {control}
    </ScrollView>
  ) : (
    control
  );
}
