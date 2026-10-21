import { useResolveClassNames } from "uniwind";
import { DEFAULT_MOBILE_THEME_ID } from "../lib/mobileTheme";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Session-avatar and child-group surfaces. The default theme uses the Paper design's values. */
export function useNavigationColors() {
  const { themeAppearance, themeId } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const screen = useResolveClassNames("bg-screen").backgroundColor;
  const surface = useResolveClassNames("bg-card").backgroundColor;
  const foreground = useResolveClassNames("text-foreground").color;
  const muted = useResolveClassNames("text-foreground-muted").color;
  const border = useResolveClassNames("bg-border").backgroundColor;
  const selected = useResolveClassNames("bg-subtle-strong").backgroundColor;
  const primary = useResolveClassNames("bg-primary").backgroundColor;
  const paper = themeId === DEFAULT_MOBILE_THEME_ID;
  return {
    dark,
    screen: !paper && typeof screen === "string" ? screen : dark ? "#18181b" : "#fafafa",
    surface: !paper && typeof surface === "string" ? surface : dark ? "#27272a" : "#ffffff",
    muted: !paper && typeof muted === "string" ? muted : dark ? "#a1a1aa" : "#71717a",
    border: !paper && typeof border === "string" ? border : dark ? "#3f3f46" : "#e4e4e7",
    accent: !paper && typeof primary === "string" ? primary : "#0284c7",
    snooze: dark ? "#52525b" : "#71717a",
    groupCounter: !paper && typeof selected === "string" ? selected : dark ? "#3f3f46" : "#e4e4e7",
    groupCounterForeground:
      !paper && typeof foreground === "string" ? foreground : dark ? "#e4e4e7" : "#52525b",
    danger: dark ? "#f87171" : "#b91c1c",
  };
}
