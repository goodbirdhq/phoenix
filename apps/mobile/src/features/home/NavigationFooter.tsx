import {
  AgentsIcon,
  PullRequestsIcon,
  SchedulesIcon,
  UsageIcon,
  EnvironmentsIcon,
  SettingsIcon,
} from "../../components/NavigationIcons";
import { useCallback, useContext, useState, useSyncExternalStore } from "react";
import {
  NavigationContainerRefContext,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import {
  footerShowsLabels,
  footerDestination,
  footerRootTarget,
  type FooterRootNavigation,
  type FooterRoute,
} from "./navigation-footer-layout";

const tabs: ReadonlyArray<{ label: string; route: FooterRoute; icon: typeof AgentsIcon }> = [
  { label: "Agents", route: "Home", icon: AgentsIcon },
  { label: "Pull Requests", route: "SettingsPullRequests", icon: PullRequestsIcon },
  { label: "Schedules", route: "SettingsSchedules", icon: SchedulesIcon },
  { label: "Usage", route: "SettingsUsage", icon: UsageIcon },
  { label: "Environments", route: "SettingsEnvironments", icon: EnvironmentsIcon },
  { label: "Settings", route: "Settings", icon: SettingsIcon },
] as const;
export function NavigationFooter({
  selected: selectedRoute,
  onNavigate,
  rootNavigation: suppliedRootNavigation,
}: {
  selected?: string;
  onNavigate?: (route: (typeof tabs)[number]["route"]) => void;
  rootNavigation?: FooterRootNavigation;
}) {
  const navigation = useNavigation();
  const rootNavigation = useContext(NavigationContainerRefContext);
  const getRootState = useCallback(
    () =>
      suppliedRootNavigation?.getState() ??
      rootNavigation?.getRootState() ??
      navigation.getState() ?? { routes: [{ name: "Home" }] },
    [navigation, rootNavigation, suppliedRootNavigation],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      suppliedRootNavigation?.subscribe(listener) ??
      rootNavigation?.addListener("state", listener) ??
      (() => {}),
    [rootNavigation, suppliedRootNavigation],
  );
  const getDestination = useCallback(() => {
    return footerDestination(getRootState());
  }, [getRootState]);
  const activeDestination = useSyncExternalStore(subscribe, getDestination, getDestination);
  const selected = selectedRoute ?? activeDestination;
  const colors = useNavigationColors();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(windowWidth);
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const labels = footerShowsLabels(width, fontScale);
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        backgroundColor: colors.screen,
        paddingHorizontal: 12,
        paddingBottom: Math.max(insets.bottom, 8),
        paddingTop: 4,
      }}
    >
      <View
        accessibilityRole="tablist"
        style={{
          height: 52,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
        }}
      >
        {tabs.map(({ label, route, icon: Icon }) => {
          const active =
            route === selected || (route === "Settings" && !tabs.some((t) => t.route === selected));
          return (
            <Pressable
              key={route}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
              onPress={() => {
                if (onNavigate) onNavigate(route);
                else if (suppliedRootNavigation) suppliedRootNavigation.navigate(route);
                else {
                  const target = footerRootTarget(getRootState(), route);
                  navigation.dispatch(
                    target.kind === "push"
                      ? StackActions.push(target.name, {
                          screen: target.screen,
                          params: target.params,
                        })
                      : StackActions.popTo(
                          target.name,
                          "screen" in target
                            ? {
                                screen: target.screen,
                                params: target.params,
                              }
                            : undefined,
                        ),
                  );
                }
              }}
              style={{
                minWidth: 44,
                minHeight: 44,
                paddingHorizontal: active && labels ? 12 : 0,
                borderRadius: 9,
                backgroundColor: active ? colors.selected : "transparent",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Icon size={20} color={active ? colors.foreground : colors.muted} />
              {active && labels ? (
                <AppText
                  numberOfLines={1}
                  style={{
                    fontSize: 14,
                    lineHeight: 20,
                    fontFamily: "DMSans-Medium",
                    color: colors.foreground,
                  }}
                >
                  {label}
                </AppText>
              ) : null}
              {route === "Settings" && (isUpdateAvailable || isUpdatePending) ? (
                <View
                  style={{
                    position: "absolute",
                    right: 4,
                    top: 4,
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: colors.accent,
                  }}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
