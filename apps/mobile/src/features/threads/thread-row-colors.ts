import type { MobileThemeVariables } from "../../lib/mobileTheme";

/**
 * Surface and text colors for a thread-list row. The iPad sidebar pane sits
 * on the drawer surface and fills the selected row with the theme's selection
 * color, so every piece of row text switches to that surface's foreground.
 */
export function getThreadRowColors(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const surfaceColor = theme[sidebarPane ? "--color-drawer" : "--color-screen"];
  const backgroundColor = selected ? theme["--color-thread-selected"] : surfaceColor;
  return {
    backgroundColor,
    swipeBackgroundColor: surfaceColor,
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    // Pointer feedback must not mix a second color into the selected fill.
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: selected
      ? "text-thread-selected-foreground"
      : sidebarPane
        ? "text-drawer-foreground"
        : "text-foreground",
    mutedForegroundClassName: selected
      ? "text-thread-selected-foreground-muted"
      : sidebarPane
        ? "text-drawer-foreground-muted"
        : "text-foreground-muted",
    mutedIconTintClassName: selected
      ? "accent-thread-selected-foreground-muted"
      : sidebarPane
        ? "accent-drawer-foreground-muted"
        : "accent-foreground-muted",
    // Provider badges blend into the surface beneath them.
    providerIconSurfaceColor: backgroundColor,
  };
}
