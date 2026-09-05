import type { DesktopUpdateState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Menu } from "../ui/menu";
import { SidebarUpdateMenuItem } from "./SidebarUpdatePill";

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
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
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
