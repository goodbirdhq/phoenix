# Dev container

> For maintainers. Using Phoenix? See [docs/user](../user/).

`.devcontainer/` gives you a ready-to-code Linux environment matching CI: Ubuntu 24.04, Node 24, pnpm, Rust stable, the global `vp` CLI, and the GitHub CLI. It also installs the Linux native libraries used by the browser-secret tests and desktop artifact builder. Open the repo in VS Code and "Reopen in Container", or create a GitHub Codespace. Dependency install (`vp i`), the Electron exec-bit repair, and the Vite dep-cache warmup all run automatically before you attach.

## What works in the container

- The full dev stack: `vp run dev`, then use the `webPort` and pairing URL from the `[dev-runner]` line. The default checkout uses web port 5833 and server port 13873, which are forwarded in advance. Worktrees and occupied ports can select a different pair; VS Code notifies when it auto-forwards those ports. If it does not, forward the printed `webPort` from the Ports panel. The bare origin is useless without the pairing token.
- In desktop VS Code, a forwarded port is a true localhost, so the printed pairing URL works as-is. In browser Codespaces, open the forwarded HTTPS origin and preserve the printed URL's `/pair` path, query, and fragment. If the server rejects that origin, set `T3CODE_DEV_ALLOWED_ORIGINS` to the forwarded origin before starting the dev stack. Do not set `VITE_HTTP_URL` or `VITE_WS_URL`; development stays single-origin so forwarded and remote clients work.
- Everything the Linux CI jobs run: focused `vp test run <files>`, `vp lint <files>`, package typechecks, `vp run build:desktop`, and the resource-monitor cargo build and tests. (`vpr` is not on PATH here; the curl installer only shims `vp`. Use `vp run <script>` or `node_modules/.bin/vpr` after install.)

## State and safety

`PHOENIX_HOME` points at the workspace's gitignored `.phoenix`, so all runtime state stays inside the container workspace, mirroring the worktree default. There is no live install to damage inside a container, but the test-data rule from AGENTS.md still holds: copy data in, never point at shared state.

## Caching

Two named volumes keep rebuilds fast and installs off the slow macOS/Windows bind mount: the pnpm store (shared across checkouts, mounted where `vp i` keeps it) and root `node_modules` (per-container, which covers the whole `.pnpm` virtual store since workspace packages just symlink into it). Deleting a container and recreating it reuses both, so a rebuild's `vp i` is seconds, not minutes. The host sees an empty `node_modules`; run host-side tooling inside the container.

## Out of scope

- Windowed Electron development is host-only. Building and verifying the desktop bundle works fine in the container (CI does exactly that, headless); launching the app needs a display.
- Mobile native builds are host-only (Xcode for iOS, Android SDK for Android). Typecheck, lint, and the mobile static checks run fine.
- `vp run dev --share` needs a tailscale binary and a tailnet; not provisioned here.

## Prebuilds

Container creation from scratch does a full `vp i` plus toolchain installs, which is worth prebuilding. Codespaces prebuilds are configured in repo settings, not files, and pick this config up as-is: the heavy steps live in `onCreateCommand` and `updateContentCommand`, which prebuilds bake in. Restrict prebuilds to one region and one retained version; storage bills per region per version. Note that prebuild snapshots exclude the caching volumes, so a prebuild-first workflow may prefer dropping the mounts. Outside Codespaces, the Dev Container CLI can push a prebuilt image:

```bash
devcontainer build --workspace-folder . --push true --image-name <registry>/phoenix-devcontainer:latest
```
