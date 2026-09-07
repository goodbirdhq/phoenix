import { SearchIcon, FilterIcon, ComposeIcon } from "../../components/NavigationIcons";
import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useRef } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import IconX from "@tabler/icons-react-native/IconX";
import { ControlPillMenu } from "../../components/ControlPill";
import { useNavigationColors } from "../../components/useNavigationColors";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import type { HomeProjectSortOrder } from "./homeThreadList";
import {
  buildHomeListFilterMenu,
  type HomeListFilterMenuEnvironment,
  type HomeListFilterMenuProject,
} from "./home-list-filter-menu";
export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;
export function HomeHeader(props: {
  readonly hideNativeHeader?: boolean;
  readonly beforeFocusSearch?: () => void;
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  const colors = useNavigationColors();
  const insets = useSafeAreaInsets();
  const input = useRef<TextInput>(null);
  const v2 = useThreadListV2Enabled();
  useHardwareKeyboardCommand("focusSearch", () => {
    props.beforeFocusSearch?.();
    input.current?.focus();
    return true;
  });
  const menu = buildHomeListFilterMenu({ ...props, listOrganization: !v2 });
  const { actions, handlers } = useMemo(() => {
    const handlers = new Map<string, () => void>();
    const actions: MenuAction[] = menu.items.map((item, i) => {
      if (item.type === "action") {
        handlers.set(String(i), item.onPress);
        return { id: String(i), title: item.title };
      }
      return {
        title: item.title,
        subactions: item.items.map((child, j) => {
          const id = `${i}:${j}`;
          handlers.set(id, child.onPress);
          return { id, title: child.title, state: child.state === "on" ? "on" : "off" };
        }),
      };
    });
    return { actions, handlers };
  }, [menu.items]);
  return (
    <>
      {props.hideNativeHeader !== false ? (
        <NativeStackScreenOptions options={{ headerShown: false }} />
      ) : null}
      <View
        style={{
          backgroundColor: colors.screen,
          paddingTop: insets.top + 12,
          paddingHorizontal: 20,
          paddingBottom: 6,
        }}
      >
        <View style={{ height: 44, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <SearchIcon size={18} color={colors.muted} />
            <TextInput
              ref={input}
              accessibilityLabel="Search conversations"
              autoCapitalize="none"
              autoCorrect={false}
              value={props.searchQuery}
              onChangeText={props.onSearchQueryChange}
              placeholder="Search"
              placeholderTextColor={colors.muted}
              style={{
                flex: 1,
                minHeight: 44,
                padding: 0,
                color: colors.foreground,
                fontFamily: "DMSans-Regular",
                fontSize: 16,
              }}
            />
            {props.searchQuery ? (
              <Pressable
                accessibilityLabel="Clear search"
                accessibilityRole="button"
                onPress={() => props.onSearchQueryChange("")}
                hitSlop={10}
              >
                <IconX size={18} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
          <ControlPillMenu
            actions={actions}
            onPressAction={({ nativeEvent }) => handlers.get(nativeEvent.event)?.()}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Filter and sort conversations"
              style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
            >
              <FilterIcon
                size={18}
                color={
                  props.selectedEnvironmentId || props.selectedProjectKey
                    ? colors.accent
                    : colors.muted
                }
              />
            </Pressable>
          </ControlPillMenu>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New task"
            onPress={props.onStartNewTask}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ComposeIcon size={20} color="#ffffff" />
            </View>
          </Pressable>
        </View>
      </View>
    </>
  );
}
