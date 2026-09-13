export const GENERAL_INSIGHT_SETTINGS_ROWS = [
  { icon: "chart.bar.xaxis", label: "Usage", target: "SettingsUsage" },
  {
    icon: "server.rack",
    label: "Environment performance",
    target: "SettingsEnvironmentPerformance",
  },
  {
    icon: "clock.arrow.circlepath",
    label: "Schedules",
    target: "SettingsSchedules",
  },
] as const;

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly activityLabel: string;
  readonly status: "Unavailable";
  readonly subtitle: string;
} {
  return {
    activityLabel: platform === "android" ? "Ongoing Agent Activity" : "Live Activity Updates",
    status: "Unavailable",
    subtitle: "Requires a configured notification delivery service.",
  };
}
