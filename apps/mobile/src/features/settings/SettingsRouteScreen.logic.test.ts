import { describe, expect, it } from "vite-plus/test";

import {
  GENERAL_INSIGHT_SETTINGS_ROWS,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
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
