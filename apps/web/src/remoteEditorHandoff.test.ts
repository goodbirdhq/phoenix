import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentEditorHandoff } from "@t3tools/contracts";

import { buildRemoteEditorTarget, launchRemoteEditor, quoteForShell } from "./remoteEditorHandoff";

const remoteHandoff: EnvironmentEditorHandoff = {
  mode: "vscode-remote-ssh",
  sshHostAlias: "dev-box",
  sourceWorkspaceRoot: "/remote/project",
  remoteWorkspaceRoot: "/home/me/work space",
};

describe("buildRemoteEditorTarget", () => {
  it("maps an in-workspace path, encodes spaces, and keeps line and column", () => {
    expect(
      buildRemoteEditorTarget({
        handoff: remoteHandoff,
        sourceWorkspaceRoot: "/remote/project",
        workspaceRelativePath: "src/my file.ts",
        line: 12,
        column: 4,
      }),
    ).toEqual({
      remotePath: "/home/me/work space/src/my file.ts",
      uri: "vscode://vscode-remote/ssh-remote+dev-box/home/me/work%20space/src/my%20file.ts:12:4",
      command:
        "code --remote 'ssh-remote+dev-box' --goto '/home/me/work space/src/my file.ts:12:4'",
    });
  });

  it("does not create a remote target for disabled, incomplete, or unsafe paths", () => {
    expect(
      buildRemoteEditorTarget({ handoff: { mode: "disabled" }, workspaceRelativePath: "a.ts" }),
    ).toBeNull();
    expect(
      buildRemoteEditorTarget({
        handoff: remoteHandoff,
        sourceWorkspaceRoot: "/remote/project",
        workspaceRelativePath: "../secret",
      }),
    ).toBeNull();
    expect(
      buildRemoteEditorTarget({
        handoff: remoteHandoff,
        sourceWorkspaceRoot: "/remote/project",
        workspaceRelativePath: null,
      }),
    ).toBeNull();
    expect(
      buildRemoteEditorTarget({
        handoff: remoteHandoff,
        sourceWorkspaceRoot: "/another/project",
        workspaceRelativePath: "src/a.ts",
      }),
    ).toBeNull();
  });
});

describe("quoteForShell", () => {
  it("contains shell metacharacters in one POSIX argument", () => {
    expect(quoteForShell("a'; rm -rf /; `x` $HOME\nnext")).toBe(
      "'a'\"'\"'; rm -rf /; `x` $HOME\nnext'",
    );
  });
});

describe("launchRemoteEditor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats browser protocol dispatch as successful", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const target = {
      uri: "vscode://vscode-remote/ssh-remote+dev-box/home/me/project/src/a.ts:4",
      command: "code --remote 'ssh-remote+dev-box' --goto '/home/me/project/src/a.ts:4'",
      remotePath: "/home/me/project/src/a.ts",
    };

    await expect(launchRemoteEditor(target)).resolves.toBe(true);
    expect(assign).toHaveBeenCalledWith(target.uri);
  });

  it("preserves an explicit desktop refusal", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("window", { desktopBridge: { openExternal } });
    const target = {
      uri: "vscode://vscode-remote/ssh-remote+dev-box/home/me/project/src/a.ts:4",
      command: "code --remote 'ssh-remote+dev-box' --goto '/home/me/project/src/a.ts:4'",
      remotePath: "/home/me/project/src/a.ts",
    };

    await expect(launchRemoteEditor(target)).resolves.toBe(false);
    expect(openExternal).toHaveBeenCalledWith(target.uri);
  });
});
