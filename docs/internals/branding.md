# Branding and the upstream fork

Phoenix is a fork of [T3 Code](https://github.com/pingdotgg/t3code). Two constraints shape every
naming decision here:

1. **Phoenix must run side by side with upstream T3 Code on the same machine.** Both apps can be
   installed and running at once, so anything the OS or filesystem keys on must differ.
2. **We merge from upstream continuously.** Every renamed line is a potential merge conflict, so we
   rename as little as possible.

These pull in opposite directions. The rule that resolves them:

> **Runtime identity diverges. Source identity does not.**

If the name is written to disk, bound to a port, registered with the OS, or shown to a user, it
becomes a Phoenix name. If it only exists inside the repository, it stays exactly as upstream has it.

## Runtime identity — diverges (must never collide)

| Concern                 | Upstream T3 Code             | Phoenix                                                                   |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| State / base dir        | `~/.t3`                      | `~/.phoenix`                                                              |
| Base dir env var        | `T3CODE_HOME`                | `PHOENIX_HOME` (no fallback — see below)                                  |
| Desktop userData dir    | `t3code`, `t3code-dev`       | `phoenix`, `phoenix-dev`                                                  |
| Desktop product name    | `T3 Code (Alpha)`            | `Phoenix (Alpha)`                                                         |
| macOS Keychain item     | `t3code Safe Storage`        | `phoenix Safe Storage` (follows the staged package name, not productName) |
| URL scheme              | `t3code://`, `t3code-dev://` | `phoenix://`, `phoenix-dev://`                                            |
| AppUserModelID          | `com.t3tools.t3code`         | `com.goodbird.phoenix`                                                    |
| Mobile bundle / package | `com.t3tools.t3code`         | `com.goodbird.phoenix`                                                    |
| Linux desktop entry     | `t3code.desktop`             | `phoenix.desktop`                                                         |
| Linux WM class          | `t3code`                     | `phoenix`                                                                 |
| Linux URL handler entry | `t3code-url-handler.desktop` | `phoenix-url-handler.desktop`                                             |
| systemd unit            | `t3code.service`             | `phoenix.service`                                                         |
| Server default port     | `3773`                       | `3873`                                                                    |
| Dev server / web ports  | `13773` / `5733`             | `13873` / `5833`                                                          |
| CLI binary              | `t3`                         | `phoenix`                                                                 |
| MCP server id           | `t3-code`                    | `phoenix`                                                                 |
| Worktree dev state      | `<worktree>/.t3`             | `<worktree>/.phoenix`                                                     |

### Two deliberate subtleties

**No legacy-userData adoption.** Upstream migrates its own pre-rename userData directory
(`T3 Code (Alpha)`) into the current one. Phoenix removes that step entirely
(`DesktopAppIdentity.resolveUserDataPath`). Adopting it would point two live applications at one
directory. A test asserts this never regresses.

**`PHOENIX_HOME` has no `T3CODE_HOME` fallback**, even though every other environment variable does.
The base dir holds the SQLite database and auth state; inheriting a `T3CODE_HOME` that the user set
for T3 Code would put both apps in one directory — the exact collision this design prevents.

### Environment variables

Phoenix reads `PHOENIX_<NAME>` first and falls back to `T3CODE_<NAME>` (`brandedString` /
`brandedBoolean` in `apps/desktop/src/app/DesktopConfig.ts`), so existing configuration keeps
working. `PHOENIX_HOME` is the documented exception above.

## Source identity — stays upstream (renaming only causes conflicts)

| Category                 | Examples                                            |
| ------------------------ | --------------------------------------------------- |
| Package scope            | `@t3tools/contracts`, `@t3tools/desktop`            |
| Workspace package name   | `t3` (`apps/server/package.json`)                   |
| File and directory names | `oxlint-plugin-t3code/`, `apps/mobile/modules/t3-*` |
| Internal symbols         | `t3Home`, `t3codeCommitHash`                        |
| Legal text               | `LICENSE`, marketing legal pages, podspec authors   |

These never reach the OS, so sharing them with upstream costs nothing and saves every merge.

## Attribution

Credit to T3 Code is required — legally by MIT, and because it is deserved:

- `README.md` — "Built on T3 Code" section
- Settings → About → "Built on T3 Code" row (`UpstreamCreditRow` in `SettingsPanels.tsx`)
- `LICENSE` — original copyright, kept intact

## Merging from upstream

Follow the [upstream integration runbook](../operations/upstream-integration.md). Conflicts are not
limited to display strings and known runtime identifiers: Phoenix features and upstream improvements
can touch the same contracts, tests, and UI without producing a textual conflict. Review both the
conflict list and every file changed by both branches.

Search the staged upstream delta for runtime identifiers from the table above. Classify results
rather than replacing them blindly: compatibility tests, source-only names, environment-variable
fallbacks, and attribution may deliberately retain an upstream name. If upstream adds a new
OS-level identifier, give it a Phoenix counterpart and add it to this table before the integration
lands.
