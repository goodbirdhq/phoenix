import {
  AgentsIcon,
  PullRequestsIcon,
  SchedulesIcon,
  UsageIcon,
  EnvironmentsIcon,
  SettingsIcon,
} from "../../components/NavigationIcons";
import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import { footerShowsLabels } from "./navigation-footer-layout";

const tabs = [
  { label: "Agents", route: "Home", icon: AgentsIcon },
  { label: "Pull Requests", route: "SettingsPullRequests", icon: PullRequestsIcon },
  { label: "Schedules", route: "SettingsSchedules", icon: SchedulesIcon },
  { label: "Usage", route: "SettingsUsage", icon: UsageIcon },
  { label: "Environments", route: "SettingsEnvironments", icon: EnvironmentsIcon },
  { label: "Settings", route: "Settings", icon: SettingsIcon },
] as const;
export function NavigationFooter({
  selected = "Home",
  onNavigate,
}: {
  selected?: string;
  onNavigate?: (route: (typeof tabs)[number]["route"]) => void;
}) {
  const navigation = useNavigation();
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
                else if (route === "Home") navigation.navigate("Home");
                else
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: route },
                  });
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
