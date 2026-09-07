/** The longest selected label must fit without changing mode between destinations. */
export function footerShowsLabels(usableWidth: number, fontScale: number, longestLabelWidth = 146) {
  return usableWidth >= 5 * 44 + Math.max(44, longestLabelWidth * fontScale) + 5 * 4 + 24;
}

export type FooterRoute =
  | "Home"
  | "SettingsPullRequests"
  | "SettingsSchedules"
  | "SettingsUsage"
  | "SettingsEnvironments"
  | "Settings";

/** Return the root route and nested target for a footer destination. */
type FooterRootState = { index?: number; routes: readonly { name: string }[] };

export function footerRootTarget(state: FooterRootState, route: FooterRoute) {
  if (route === "Home") return { kind: "popTo" as const, name: "Home" as const };
  const currentIndex = state.index ?? state.routes.length - 1;
  const settingsExists = state.routes
    .slice(0, currentIndex + 1)
    .some((candidate) => candidate.name === "SettingsSheet");
  return {
    kind: settingsExists ? ("popTo" as const) : ("push" as const),
    name: "SettingsSheet" as const,
    screen: "SettingsContent",
    params: { screen: route },
  };
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
