import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "./AppText";

export function SegmentedControl<Value extends number | string>(props: {
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly scrollable?: boolean;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  const control = (
    <View className="flex-row overflow-hidden rounded-full border-continuous bg-card">
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            style={props.scrollable ? { flex: 0, paddingHorizontal: 16 } : undefined}
            className={
              active
                ? "flex-1 items-center rounded-full bg-subtle-strong py-2"
                : "flex-1 items-center py-2"
            }
          >
            <Text
              className={
                active ? "text-sm font-t3-medium text-foreground" : "text-sm text-foreground-muted"
              }
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return props.scrollable ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {control}
    </ScrollView>
  ) : (
    control
  );
}
