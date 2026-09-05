# Install Phoenix

Phoenix is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Phoenix server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
phoenix
```

This starts the Phoenix server on your machine and opens the local web app. Use
`phoenix --help` for the full CLI reference.

## Open a project in the desktop app

When the Phoenix desktop app is running on the same machine, open the current directory with:

```bash
npx @goodbirdhq/phoenix app
```

Pass a path to open another directory:

```bash
npx @goodbirdhq/phoenix app ../my-project
```

The command adds the directory as a project when needed, focuses the desktop app, and opens a new
thread. It does not launch the desktop app, open a browser, or start a Phoenix server. A background
server does not count as the desktop app. The command also rejects SSH sessions because a remote
shell cannot focus a local desktop window. The CLI package and the running desktop app must both
include `phoenix app` support.

## Desktop App

Download the latest release from
[Phoenix GitHub Releases](https://github.com/goodbirdhq/phoenix/releases). Phoenix is not currently
published through `winget`, Homebrew, or the AUR; packages named T3 Code install the upstream
product instead.

### Windows Subsystem for Linux

When the desktop app runs a WSL backend, it installs the matching server runtime into
`~/.phoenix/wsl-runtime` inside the selected distro. The first launch after installing or updating Phoenix may take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After a
successful launch, Phoenix keeps the current runtime and one previous runtime for rollback and
removes older caches automatically. If a cached runtime stops working, Phoenix launches from the
application files under `/mnt/c` instead and reinstalls the runtime on the next launch.

## Providers

Phoenix drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Phoenix looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the Phoenix server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Phoenix.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Phoenix. You can install Phoenix, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much Phoenix asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Phoenix in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
