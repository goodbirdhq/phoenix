# CI in the Phoenix fork

Upstream T3 Code's pipelines assume T3 Tools' infrastructure: Blacksmith runners, Apple and Azure
signing certificates, Vercel, Cloudflare, PlanetScale, Clerk, Expo, and their Discord. Phoenix has
none of that, so most of it is switched off.

The same rule as [branding.md](./branding.md) applies: **change as little of upstream's files as
possible.** Anything we can turn off outside the repository, we do.

## What runs

| Workflow                              | State  | Notes                                                                                       |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `CI` (`ci.yml`)                       | **on** | `check`, `test`, `release_smoke`. Our only edits are the runner labels and one `if: false`. |
| `Phoenix Build` (`phoenix-build.yml`) | **on** | Phoenix-only file. Unsigned macOS build per merge to `main`.                                |
| `PR Size`, `Issue Labels`             | on     | Self-contained, no external services.                                                       |

## What is disabled, and why

Disabled **GitHub-side** with `gh workflow disable`, so the files stay byte-identical to upstream
and never conflict on merge:

| Workflow                                       | Why                                                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Release`                                      | ~29 secrets: Apple notarisation, Azure Trusted Signing, Vercel, Cloudflare, PlanetScale, Clerk, Axiom. Replaced by `Phoenix Build`. |
| `Deploy T3 Connect relay`                      | Deploys to T3's relay infrastructure.                                                                                               |
| `Web Preview`                                  | Deploys to T3's Vercel/Cloudflare projects.                                                                                         |
| `Mobile EAS Preview` / `Mobile EAS Production` | Needs T3's Expo account (`EXPO_TOKEN`).                                                                                             |
| `Mobile Fingerprint Check`                     | Native mobile work is parked; would flag our bundle-ID and scheme changes on every PR.                                              |
| `Mobile Showcase Screenshots`                  | Marketing screenshots for T3's app-store listings.                                                                                  |
| `PR Vouch`                                     | Upstream's contributor-vouching process.                                                                                            |
| `Thread Transfer Report`                       | Upstream-internal reporting.                                                                                                        |

Re-enable any of them with `gh workflow enable "<name>"`. Because this is repository state rather
than committed config, it is **invisible in a fresh clone** — that is the trade-off we accepted for
zero merge conflicts. This table is the record.

`ci.yml`'s `mobile_native_static_analysis` job is the exception: it is disabled in-repo with
`if: false` because it is a job inside an otherwise-enabled workflow. Flip it back when mobile
native work restarts.

## Runners

Upstream targets Blacksmith (`blacksmith-8vcpu-ubuntu-2404`, `blacksmith-6vcpu-macos-26`). A fork
without a Blacksmith installation queues those jobs forever — they never fail, they just never
start. `ci.yml` therefore points at GitHub-hosted runners (`ubuntu-24.04`, `macos-15`), which are
free on this public repository.

If you connect Blacksmith to this repository, reverting to upstream's labels makes `ci.yml`
byte-identical to upstream again and removes the last CI merge-conflict point:

```bash
git checkout upstream/main -- .github/workflows/ci.yml   # then re-apply `if: false` if still wanted
```

## Phoenix Build

Runs on every merge to `main`, and on demand via **Actions → Phoenix Build → Run workflow**.

It produces an **unsigned** arm64 macOS DMG, uploads it as a run artifact, publishes a GitHub
pre-release tagged `build-<version>+<sha>`, and posts to Slack.

Unsigned means Gatekeeper quarantines the app. The release notes and the Slack message both carry
the fix, because it is not discoverable — macOS reports a missing signature as _"Phoenix is damaged
and can't be opened"_, which reads like a corrupted download:

```bash
xattr -dr com.apple.quarantine /Applications/Phoenix.app
```

### Slack setup

The notify step reads `SLACK_RELEASE_WEBHOOK_URL` and **skips silently when it is unset**, so the
build does not fail before the secret exists.

1. Create an incoming webhook at <https://api.slack.com/messaging/webhooks>.
2. `gh secret set SLACK_RELEASE_WEBHOOK_URL --repo goodbirdhq/phoenix`

It notifies on failure as well as success — a build pipeline that only reports good news is worse
than none.

### Not covered yet

- **Signing and notarisation.** Needs an Apple Developer ID; until then every install needs the
  `xattr` step above.
- **Linux and Windows.** Add to the `build_macos` job as a matrix when needed.
- **Auto-update.** Upstream's updater expects signed builds served from their update feed.
