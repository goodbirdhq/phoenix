import type { EnvironmentEditorHandoff } from "@t3tools/contracts";

export interface RemoteEditorTarget {
  readonly uri: string;
  readonly command: string;
  readonly remotePath: string;
}

export function quoteForShell(value: string): string {
  // POSIX single quotes preserve every shell metacharacter. A literal quote is
  // represented by closing the quote, adding an escaped quote, then reopening.
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Maps a trusted workspace-relative path to the user-owned Remote-SSH workspace. */
export function buildRemoteEditorTarget(input: {
  readonly handoff: EnvironmentEditorHandoff;
  readonly sourceWorkspaceRoot?: string | undefined;
  readonly workspaceRelativePath?: string | null | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}): RemoteEditorTarget | null {
  if (
    input.handoff.mode !== "vscode-remote-ssh" ||
    !input.handoff.sshHostAlias ||
    input.sourceWorkspaceRoot !== input.handoff.sourceWorkspaceRoot ||
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
  // Browsers do not report whether a custom protocol handler accepted this.
  // Dispatch is still successful; the caller keeps an explicit copy fallback
  // visible without showing a false failure when VS Code accepted the URI.
  return true;
}
