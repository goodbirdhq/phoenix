import { describe, expect, it } from "vite-plus/test";

import {
  GENERAL_INSIGHT_SETTINGS_ROWS,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("presents Android notification capability as unavailable without delivery", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      activityLabel: "Ongoing Agent Activity",
      status: "Unavailable",
      subtitle: "Requires a configured notification delivery service.",
    });
  });

  it("presents iOS Live Activity capability as unavailable without delivery", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      activityLabel: "Live Activity Updates",
      status: "Unavailable",
      subtitle: "Requires a configured notification delivery service.",
    });
  });
});

describe("Settings navigation", () => {
  it("places environment performance beside Usage and Schedules", () => {
    expect(GENERAL_INSIGHT_SETTINGS_ROWS.map((row) => row.target)).toEqual([
      "SettingsUsage",
      "SettingsEnvironmentPerformance",
      "SettingsSchedules",
    ]);
  });
});
