/** The longest selected label must fit without changing mode between destinations. */
export function footerShowsLabels(usableWidth: number, fontScale: number, longestLabelWidth = 146) {
  return usableWidth >= 5 * 44 + Math.max(44, longestLabelWidth * fontScale) + 5 * 4 + 24;
}

type RouteState = { index?: number; routes: readonly { name: string; state?: RouteState }[] };

/** Resolve the selected destination through nested settings navigators. */
export function footerDestination(state: RouteState): string {
  let route = state.routes[state.index ?? 0];
  while (route?.state) route = route.state.routes[route.state.index ?? 0];
  const name = route?.name ?? "Home";
  if (name.startsWith("SettingsPullRequests")) return "SettingsPullRequests";
  if (name.startsWith("SettingsSchedule")) return "SettingsSchedules";
  if (name.startsWith("SettingsUsage")) return "SettingsUsage";
  if (name.startsWith("SettingsEnvironment")) return "SettingsEnvironments";
  return name.startsWith("Settings") ? "Settings" : "Home";
}
