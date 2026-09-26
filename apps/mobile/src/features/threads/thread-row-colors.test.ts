import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";

import { getMobileThemeVariables } from "../../lib/mobileTheme";
import { getThreadRowColors } from "./thread-row-colors";

describe("thread row colors", () => {
  it.each(MOBILE_THEME_IDS)(
    "preserves active selection and uses neutral hover for %s",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const theme = getMobileThemeVariables(themeId, appearance);
        const idle = getThreadRowColors(theme, true, false);
        const active = getThreadRowColors(theme, true, true);

        expect(idle.backgroundColor).toBe(theme["--color-drawer"]);
        expect(idle.interactionClassName).toBe("bg-thread-hover");
        expect(idle.interactionOpacity).toBe(1);
        expect(active.backgroundColor).toBe(theme["--color-thread-selected"]);
        // Swipe actions reveal against the pane, not the selection fill.
        expect(active.swipeBackgroundColor).toBe(theme["--color-drawer"]);
        // Pointer feedback must not mix a second color into the active background.
        expect(active.interactionOpacity).toBe(0);
        expect(active.providerIconSurfaceColor).toBe(active.backgroundColor);
        expect(idle.foregroundClassName).toBe("text-drawer-foreground");
        expect(idle.mutedForegroundClassName).toBe("text-drawer-foreground-muted");

        const phone = getThreadRowColors(theme, false, false);
        expect(phone.swipeBackgroundColor).toBe(theme["--color-screen"]);
        expect(phone.interactionClassName).toBe("bg-row-hover");
        expect(phone.foregroundClassName).toBe("text-foreground");
      }
    },
  );
});
