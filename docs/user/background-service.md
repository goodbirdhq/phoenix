# Running Phoenix in the Background

Phoenix's inherited background-service implementation requires an exact-version package
distribution. Phoenix is not published to npm, so new background-service installs and updates are
currently disabled: installing the upstream `t3` package would run a different product.

For now, run the source-built server in a terminal or create a service definition you manage
yourself. To update a server you run that way, follow the
[self-managed server update runbook](../operations/updating-a-self-managed-server.md). Do not run `phoenix service install` or `phoenix service update` until Phoenix has an owned
package identity and this page announces that distribution.

If an older Phoenix background service is already installed, you can inspect it:

```sh
phoenix service status
```

You can stop it and remove it from startup:

```sh
phoenix service uninstall
```

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
