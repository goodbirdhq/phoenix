import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarFooterPage } from "./mainAppLocation";

describe("resolveSidebarFooterPage", () => {
  it("keeps the tab row on scheduled tasks and shows Back on other settings pages", () => {
    expect(resolveSidebarFooterPage("/settings/scheduled-tasks")).toBe("schedules");
    expect(resolveSidebarFooterPage("/settings")).toBe("settings");
    expect(resolveSidebarFooterPage("/settings/providers")).toBe("settings");
  });

  it("marks the utility tabs and treats thread routes as Agents", () => {
    expect(resolveSidebarFooterPage("/usage")).toBe("usage");
    expect(resolveSidebarFooterPage("/pull-requests")).toBe("pull-requests");
    expect(resolveSidebarFooterPage("/")).toBe("agents");
    expect(resolveSidebarFooterPage("/env-1/thread-1")).toBe("agents");
  });

  it("leaves project settings without an active tab", () => {
    expect(resolveSidebarFooterPage("/projects/abc")).toBeNull();
  });
});
