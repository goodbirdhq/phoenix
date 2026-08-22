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
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}
