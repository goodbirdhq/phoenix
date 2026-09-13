import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-sqlite", () => ({}));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences", () => {
  it.each([true, false])(
    "retains the Live Activity preference while delivery is unavailable (%s)",
    (liveActivitiesEnabled) => {
      expect(
        sanitizePreferences({
          liveActivitiesEnabled,
          sidebarAttentionFirstEnabled: true,
        }),
      ).toMatchObject({ liveActivitiesEnabled, sidebarAttentionFirstEnabled: true });
    },
  );
});
