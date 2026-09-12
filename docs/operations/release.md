# Releasing Phoenix

> For maintainers. Using Phoenix? See [docs/user](../user/).

All production publication is manual. Main pushes and tags run no desktop, npm,
hosted-web, or mobile production release. A version bump alone publishes nothing.

## Desktop and npm

Use **Actions → Release → Run workflow**, selecting the intended ref:

- `channel=stable` requires `version` (for example `1.2.3` or `1.2.3-alpha.1`).
- `channel=nightly` derives a prerelease version from the selected commit and run.
  There is no nightly schedule.
- `publish_npm` defaults to false. Enable it to publish `@goodbirdhq/phoenix` using
  npm trusted publishing; repository variable `NPM_TRUSTED_PUBLISHING=true` and
  the matching npm-side publisher configuration are required. The workspace name
  `t3` is retained for compatibility and must never be used as the npm identity.
- `publish_web` defaults to false. Enable it only after configuring Phoenix's
  Vercel targets below.

The workflow retains lint, typecheck, tests, native packaging and updater metadata.
The currently enabled desktop target is macOS arm64; other platform entries remain
parked. A requested npm publication must succeed before the GitHub Release publishes.
Stable versions without a suffix become latest; suffixed stable versions and all
nightlies are prereleases. Release notes compare against the previous tag in the
same channel. Existing release assets can be replaced by rerunning a release;
use the same source ref and version when repairing a failed publication.

Stable finalization aligns package versions on main. Optional `RELEASE_APP_ID` and
`RELEASE_APP_PRIVATE_KEY` authorize a repository-scoped contents-write App token;
without them it uses the workflow token, subject to branch policy. Nightlies do not
write version bumps. These commits do not trigger another production publication.
Signing/notarization remains conditional on configured platform credentials.

Phoenix Build was removed: it duplicated desktop publication on each main push.
Label-driven desktop previews remain separate from production releases.

## Public client configuration

Client release jobs do not deploy relay infrastructure, read production state, or fetch
tracing credentials. The inherited `deploy-relay.yml` workflow was removed, not the runtime or
infrastructure product code.

Optional **repository Actions variable**:

- `T3CODE_RELAY_URL`: explicit HTTPS origin of a separately deployed relay, baked into clients
  that should offer one. Leave unset for clients with no baked-in relay.

No relay URL is derived from a DNS zone, and no Cloudflare, PlanetScale, Axiom or relay tracing
token is required by the release workflow. This is public client configuration, not
infrastructure credentials. Configure the same intended relay for stable and nightly clients.

## Optional hosted web publication

The web client remains available for future hosting. A Release dispatch must set
`publish_web=true`; otherwise there is no hosted production deployment. Configure
Phoenix's Vercel project with repository secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
and `VERCEL_PROJECT_ID`, plus optional variable `VERCEL_TEAM_SLUG`.

All three repository variables are required for hosted publication:

- `T3CODE_WEB_ROUTER_URL`: the Phoenix HTTPS origin users open
- `T3CODE_WEB_LATEST_DOMAIN`: Phoenix stable channel hostname
- `T3CODE_WEB_NIGHTLY_DOMAIN`: Phoenix nightly channel hostname

Use three distinct targets owned by Phoenix and configured on that Vercel project.
There are no upstream `t3.codes` fallbacks. The deployment config receives the same
validated targets as the alias commands. Stable publication aliases the deployment
to the latest and router hostnames; nightly publication changes only the nightly
alias. Keep the Vercel project root at `apps/web`; automatic Git deployments remain
disabled in `apps/web/vercel.ts`.

Connect configuration is optional even for hosted web: a standalone client can use
manual pairing. With no routing tuple, preview deployments serve their own client
and do not forward requests to an upstream host. The channel selector continues to
use `/__t3code/channel` and the existing channel cookie when routing is configured.

## Mobile production

Use **Actions → Mobile EAS Production → Run workflow**, selecting the intended ref:

- `mode=build` builds and auto-submits the selected platform (`ios`, `android`, or
  `all`) using the production profile. iOS submission goes to TestFlight; releasing
  to the App Store remains a separate App Store Connect action. Android submission
  requires the Phoenix Play credentials to have been configured.
- `mode=update` explicitly publishes an OTA to the production channel for the
  selected platform. Confirm compatible production binaries exist before choosing
  this mode. There is no automatic merge-driven build reconciliation or OTA.
- Optional `version` applies only to build mode and commits the version override to
  the selected branch with the Release App identity before building. It requires a
  branch ref and the App credentials. Leave it blank to use `app.config.ts`.

`EXPO_TOKEN` is required; a missing token fails the requested release. Builds run on
Linux with the repository toolchain so local fingerprint calculation and EAS agree.
The existing Phoenix identities are preserved: Expo `@neilbarton/phoenix`, Apple
team `39DYB2TD96`, ASC app `6807867658`. Update messages are passed as data, not shell
source. Explicit release requests queue without cancelling an active publication.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship a
Linux-only `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar. WSL verifies
and extracts that archive into `~/.phoenix/wsl-runtime/sha256-<archive-digest>` inside
the selected distro, then reuses it for later launches of the same update. The
Windows-side `wsl-server-tree/<version>` extraction remains a fallback and is
removed after the distro-local runtime passes preflight.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build with a WSL node-pty prebuild omits the WSL archive or SHA-256
  sidecar, the sidecar digest does not match the emitted archive, or required
  Linux runtime members are absent.
- The emitted WSL archive contains Windows/Darwin node-pty payloads, ConPTY,
  pnpm install metadata, or Windows-only FFF, ffi-rs, or msgpackr bindings.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 1) Release authorization

A Release dispatch publishes a GitHub Release, optionally npm and hosted web, and
may commit stable version alignment to main. Use a reviewed source ref and verify
selected publication options before dispatching. Tags alone publish nothing.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Required repository variables:

- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.goodbird.phoenix`.
3. Create a `Developer ID Application` certificate.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
7. In App Store Connect, create an API key (Team key).
8. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
9. Dispatch a release and confirm macOS artifacts are signed and notarized. Signed builds carry
   only hardened-runtime entitlements (JIT, unsigned executable memory, library-validation
   disabled for bundled native modules); no provisioning profile is required.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Dispatch a release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Dispatch Release with `channel=stable` and the intended version/ref.
4. Select npm or hosted-web publication only when intended.
5. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - all matrix builds pass
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.goodbird.phoenix` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
