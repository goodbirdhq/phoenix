# Keeping Phoenix in Sync

The Phoenix client and server work best when they use the same version. If they do not match,
Phoenix shows a warning above the conversation composer and in **Settings → Connections**.

Dismissal hides that reminder only for the current client/server version pair. It does not update
the server.

## Updating

When a desktop update is available, **Settings → General** shows a **Release notes** link
beside the app version. The link stays available while downloading and before installing.

- For a desktop-managed server, update the Phoenix desktop app on the machine that runs it.
- For a source-built command-line server, check out the matching Phoenix revision, rebuild it, stop
  the old process after active work finishes, and relaunch it with the same startup options. If you
  run that server under a service definition you manage, follow the step-by-step
  [self-managed server update runbook](../operations/updating-a-self-managed-server.md).

Phoenix publishes its CLI as `@goodbirdhq/phoenix` on npm; update a global install with
`npm install -g @goodbirdhq/phoenix@latest`. A background-service host should update with
`npx @goodbirdhq/phoenix@latest service update` — `phoenix service update` uses whatever CLI is
on PATH, which can be older than the running service. Never substitute `npx t3`: that installs
upstream T3 Code, not Phoenix.

Updating or restarting interrupts active agent work and terminal commands. Saved threads, settings,
and project files remain on the server machine.

## Before you update

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
Phoenix must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Choose the Action You See

| Action                     | What to do                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Available for the Phoenix Linux background service and for servers run by a current Phoenix desktop app. Select the button and leave Phoenix open while it downloads, installs, restarts, and reconnects. For desktop-app servers this closes and relaunches the desktop app on that machine. If installation fails, the desktop app stays open and reconnects to its server. |
| **Update the desktop app** | Shown for desktop apps that predate remote updates. Open the Phoenix desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                                                                                                                                                                                                   |
| **Copy update command**    | Copy the command, open a terminal on the server machine, stop the current Phoenix server, and relaunch it with the copied command and any startup options you normally use.                                                                                                                                                                                                   |

The available action depends on how that server was started. Phoenix does not update connected
servers silently in the background.

An older background-service launcher may ask you to run the exact
`npx @goodbirdhq/phoenix@<version> service update` command on the server machine. That one local update installs the
rollback support needed for later remote updates, including versions that change the database.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

**Copy update command** gives you `npx @goodbirdhq/phoenix@<client-version>`, which relaunches the server directly
at the matching version. Add whatever startup options you normally use.

If the server instead runs as the Phoenix background service, update the service on the host and
pin the same version:

```sh
npx @goodbirdhq/phoenix@<client-version> service update
```

`service update` installs the version of the CLI that invoked it, so `npx @goodbirdhq/phoenix@latest service update`
only resolves the skew when your client happens to be on the latest release. The exact version from
the warning always works.

See [Running Phoenix in the Background](./background-service.md) for install, status, and removal
commands.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, relaunch it with `npx @goodbirdhq/phoenix@<client-version>`, replacing
   `<client-version>` with the client version shown in the warning.

## Mobile updates

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
