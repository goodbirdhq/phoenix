import { describe, expect, it } from "vite-plus/test";

import {
  GENERAL_INSIGHT_SETTINGS_ROWS,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
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
