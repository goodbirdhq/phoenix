# Phoenix

Phoenix is an "agent harness control surface". It enables control of the agents on your machine from a mobile app, a web app, and an Electron-based desktop app.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, Phoenix can control them.

## Built on T3 Code

**Phoenix is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by [T3 Tools Inc.](https://t3.codes) — and T3 Code is the nuts.**

Essentially all of the hard engineering here — the architecture, the agent harness integrations, the mobile app, the sync layer — is theirs. They built something genuinely excellent and open-sourced it under MIT, which is the only reason this fork can exist. Phoenix tracks their upstream and merges their work continuously; we are downstream consumers of an outstanding project, not competitors with it.

If you want the original, supported, first-party product, go get it:

- Desktop / web: <https://t3.codes> · <https://app.t3.codes>
- iOS: [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) · Android: [Play Store](https://play.google.com/store/apps/details?id=com.t3tools.t3code)
- Source: <https://github.com/pingdotgg/t3code> · Community: [Discord](https://discord.gg/jn4EGJjrvv)

Phoenix is an unofficial fork. Please don't take Phoenix bugs to the T3 Code team — file them here instead.

## Installation

> [!WARNING]
> Phoenix currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run the server

Phoenix is not published to npm, so there is no `npx` one-liner. Build from source and run the CLI
(requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
vp i && vp run --filter t3 build
node apps/server/dist/bin.mjs
```

This launches Phoenix's backend on your machine along with the local web app. Installing the package
globally puts the CLI on your `PATH` as `phoenix` (not `t3`, so it will not collide with an existing
T3 Code install).

Tip: `phoenix --help` for the full CLI reference.

> [!NOTE]
> `npx t3@latest` runs **upstream T3 Code**, not Phoenix.

### Desktop app

Phoenix desktop builds come from this repository's [GitHub Releases](https://github.com/goodbirdhq/phoenix/releases), or you can build from source (see [docs/internals/overview.md](./docs/internals/overview.md)).

> [!NOTE]
> Phoenix is not currently published to `winget`, Homebrew, or the AUR. The upstream packages
> (`T3Tools.T3Code`, `--cask t3-code`, `t3code-bin`, and `t3code-nightly-bin`) install
> **T3 Code**, not Phoenix—which is a perfectly good choice if you would rather run the original.
> Phoenix retains upstream's AUR packaging sources under [`packaging/aur`](./packaging/aur) as a
> reference, but the release workflow does not invoke them because they remain configured for T3
> Code.

## Some notes

This is an early-stage fork. Expect bugs, and expect them to be ours rather than upstream's.

Phoenix continuously merges from upstream T3 Code. See [docs/internals/branding.md](./docs/internals/branding.md) for the fork's rebranding policy — it exists specifically to keep those merges clean.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run Phoenix as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Phoenix uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug, requesting a feature, or opening a PR.

Need support with Phoenix? Open an issue on this repository. The [T3 Code Discord](https://discord.gg/jn4EGJjrvv) is for upstream T3 Code — please don't take fork-specific problems there.

## License

Phoenix is MIT licensed and retains the [original T3 Code copyright](./LICENSE) held by T3 Tools Inc.
