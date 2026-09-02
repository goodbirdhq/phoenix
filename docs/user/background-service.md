# Running Phoenix in the Background

Phoenix publishes its server as `@goodbirdhq/phoenix` on npm, and the background service installs
exact pinned versions of that package. From an npm-installed CLI:

```sh
phoenix service install
```

That registers Phoenix as a background service for your user and starts it. To update the service
to the latest release later:

```sh
npx @goodbirdhq/phoenix@latest service update
```

Inspect the installed service — including whether the running service build matches your CLI:

```sh
phoenix service status
```

You can stop it and remove it from startup:

```sh
phoenix service uninstall
```

The service uses the same Phoenix version as the CLI you run. To install a nightly or an exact
version, use that version of the published package:

```sh
npx @goodbirdhq/phoenix@nightly service update
npx @goodbirdhq/phoenix@1.2.3 service update
```

The install and update commands refuse to replace a newer service with an older version. Setup
through T3 Connect leaves a newer service unchanged. To downgrade, select the exact older version
and pass `--allow-downgrade`:

```sh
npx @goodbirdhq/phoenix@1.2.3 service update --allow-downgrade
```

Updating restarts Phoenix briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The service runs a small stable launcher. Exact Phoenix versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

Running a source checkout instead? Keep managing your own service definition and follow the
[self-managed server update runbook](../operations/updating-a-self-managed-server.md) — `service
install` pins published releases, not your local build.

## Platform Support

**Linux** services use a systemd user unit at `~/.config/systemd/user/phoenix.service`. The
service starts when the machine boots and keeps running after you log out.

**macOS** services use a launch agent at
`~/Library/LaunchAgents/com.goodbird.phoenix.service.plist`. It starts when you log in, not when
the Mac boots, and it stops when you log out; macOS has no equivalent of Linux lingering for user
agents. For a Mac that should stay reachable unattended, turn on automatic login (System Settings →
Users & Groups; unavailable while FileVault is on) and keep the Mac from sleeping.

A few more macOS notes:

- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads,
  attributed to a bare `node` process, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the node binary listed in the launch agent's
  `ProgramArguments`.
- The agent appears under System Settings → General → Login Items. If it was switched off there,
  or disabled with `launchctl disable`, macOS will not start it at login until you switch it back
  on.

**Windows** is not supported yet.

T3 Connect and the background service have independent lifecycles. Signing out of T3 Connect does
not remove an existing service. Use `phoenix service uninstall` when you no longer want Phoenix to
start in the background.
