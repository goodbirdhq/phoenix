import type { EnvironmentEditorHandoff } from "@t3tools/contracts";

export interface RemoteEditorTarget {
  readonly uri: string;
  readonly command: string;
  readonly remotePath: string;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Maps a trusted workspace-relative path to the user-owned Remote-SSH workspace. */
export function buildRemoteEditorTarget(input: {
  readonly handoff: EnvironmentEditorHandoff;
  readonly workspaceRelativePath?: string | null | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}): RemoteEditorTarget | null {
  if (
    input.handoff.mode !== "vscode-remote-ssh" ||
    !input.handoff.sshHostAlias ||
    !input.handoff.remoteWorkspaceRoot ||
    !input.workspaceRelativePath ||
    input.workspaceRelativePath.startsWith("/") ||
    input.workspaceRelativePath.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    return null;
  }

  const remotePath = `${input.handoff.remoteWorkspaceRoot.replace(/\/$/, "")}/${input.workspaceRelativePath}`;
  const position = input.line ? `:${input.line}${input.column ? `:${input.column}` : ""}` : "";
  const authority = `ssh-remote+${encodeURIComponent(input.handoff.sshHostAlias)}`;
  return {
    remotePath,
    uri: `vscode://vscode-remote/${authority}${encodePath(remotePath)}${position}`,
    command: `code --remote ${quoteForShell(authority)} --goto ${quoteForShell(`${remotePath}${position}`)}`,
  };
}

/** Kept behind a deliberate click; this never contacts the connected environment. */
export async function launchRemoteEditor(target: RemoteEditorTarget): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.desktopBridge) {
    return window.desktopBridge.openExternal(target.uri);
  }
  window.location.assign(target.uri);
  return true;
}
