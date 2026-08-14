import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentEditorHandoff } from "@t3tools/contracts";

import { buildRemoteEditorTarget } from "./remoteEditorHandoff";
import { resolveEditorOpenPlan } from "./editorPreferences";

const remoteHandoff: EnvironmentEditorHandoff = {
  mode: "vscode-remote-ssh",
  sshHostAlias: "dev-box",
  remoteWorkspaceRoot: "/home/me/work space",
};

describe("buildRemoteEditorTarget", () => {
  it("maps an in-workspace path, encodes spaces, and keeps line and column", () => {
    expect(
      buildRemoteEditorTarget({
        handoff: remoteHandoff,
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
        handoff: { mode: "vscode-remote-ssh" },
        workspaceRelativePath: "a.ts",
      }),
    ).toBeNull();
    expect(
      buildRemoteEditorTarget({ handoff: remoteHandoff, workspaceRelativePath: "../secret" }),
    ).toBeNull();
    expect(
      buildRemoteEditorTarget({ handoff: remoteHandoff, workspaceRelativePath: null }),
    ).toBeNull();
  });
});

describe("editor handoff selection", () => {
  it("selects local handoff instead of the environment shell for configured workspace files", () => {
    expect(
      resolveEditorOpenPlan(remoteHandoff, { workspaceRelativePath: "src/app.ts", line: 3 }),
    ).toMatchObject({ kind: "remote", target: { remotePath: "/home/me/work space/src/app.ts" } });
  });

  it("keeps local mode environment-directed and makes disabled/mobile-style clients unavailable", () => {
    expect(
      resolveEditorOpenPlan(
        { mode: "local-server-editor" },
        { workspaceRelativePath: "src/app.ts" },
      ),
    ).toEqual({ kind: "environment" });
    expect(
      resolveEditorOpenPlan({ mode: "disabled" }, { workspaceRelativePath: "src/app.ts" }),
    ).toEqual({ kind: "unavailable" });
  });
});
