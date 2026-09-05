import type { DesktopUpdateState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Menu } from "../ui/menu";
import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  shouldUseSidebarUpdateReleaseNotesPopover,
  SidebarUpdateMenuItem,
} from "./SidebarUpdatePill";

const update = vi.hoisted(() => ({ state: null as DesktopUpdateState | null }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => update.state }));

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const nightlyState: DesktopUpdateState = {
  ...baseState,
  status: "available",
  channel: "nightly",
  availableVersion: "1.1.0-nightly.3",
  releaseNotes: [{ version: "1.1.0-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
};
const renderItem = () =>
  renderToStaticMarkup(
    <Menu>
      <SidebarUpdateMenuItem />
    </Menu>,
  );

describe("desktop update settings menu", () => {
  beforeEach(() => {
    update.state = null;
  });

  it("keeps a disabled check action when the bridge has no update state", () => {
    const html = renderItem();
    expect(html).toContain("Check for updates");
    expect(html).toContain('aria-disabled="true"');
  });

  it("shows the available badge once an update can be downloaded", () => {
    update.state = { ...baseState, status: "available", availableVersion: "1.1.0" };
    const html = renderItem();
    expect(html).toContain("Available");
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("offers restart for a downloaded update", () => {
    update.state = { ...baseState, status: "downloaded", downloadedVersion: "1.1.0" };
    expect(renderItem()).toContain("Restart to update");
  });
});

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, { ...nightlyState, channel: "latest" }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, { ...nightlyState, releaseNotes: [] }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes only forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();

    const event = { key: "Tab", shiftKey: false, preventDefault };
    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");
    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();

    open.mockClear();
    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );
    expect(open).not.toHaveBeenCalled();
  });
});
