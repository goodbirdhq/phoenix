# Install Phoenix

Phoenix runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Command-line use, SSH hosts, and WSL backends need Node.js `^22.16 || ^23.11 || >=24.10`. The
native desktop app includes its server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch Phoenix and configure providers afterwards.

## Run without installing

```bash
phoenix
```

This starts the Phoenix server on your machine and opens the local web app. Use
`phoenix --help` for the full CLI reference.

## Desktop app

Download the latest release from
[Phoenix GitHub Releases](https://github.com/goodbirdhq/phoenix/releases). Phoenix is not currently
published through `winget`, Homebrew, or the AUR; packages named T3 Code install the upstream
product instead.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects there. Install
Node.js and provider CLIs inside that distro. When the desktop app runs a WSL backend, it
installs the matching server runtime into `~/.phoenix/wsl-runtime` inside the selected distro. The
first launch after installing or updating Phoenix may take a little longer while that release's
runtime is extracted. Later launches reuse the Linux-local copy so startup does not depend on
reading application files through `/mnt/c`. After a successful launch, Phoenix keeps the current
runtime and one previous runtime for rollback and removes older caches automatically. If a cached
runtime stops working, Phoenix launches from the application files under `/mnt/c` instead and
reinstalls the runtime on the next launch.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
npx @goodbirdhq/phoenix app
```

This opens a new thread for the current directory, adding the project if needed.

```bash
npx @goodbirdhq/phoenix app ../my-project
```

The command adds the directory as a project when needed, focuses the desktop app, and opens a new
thread. It does not launch the desktop app, open a browser, or start a Phoenix server. A background
server does not count as the desktop app. The command also rejects SSH sessions because a remote
shell cannot focus a local desktop window. The CLI package and the running desktop app must both
include `phoenix app` support. If the command cannot reach the app, start or update the desktop app
and try again.

## Mobile app

Install Phoenix from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

## Providers

Phoenix drives provider CLIs; it does not ship them. Open **Settings → Providers** in the web or
desktop app, select the environment, and enable the provider you want. Installation, login, and
configuration belong to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Phoenix's provider settings.                            |

Provider CLIs must be on the server's `PATH`. If Phoenix cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Phoenix looks for, but authenticate with `agent login`, not `cursor-agent login`.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Phoenix can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Phoenix does not display
their original values.

Run the login command on the machine running the Phoenix server, not on the device you browse
from.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

Provider auth is required before you start a session with that provider, not before you start
Phoenix. You can install Phoenix, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work
- [Permission modes](./permission-modes.md): how much Phoenix asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Phoenix in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): keep a Linux or macOS host available
