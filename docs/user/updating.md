# Keeping Phoenix in Sync

The Phoenix client and server work best when they use the same version. If they do not match,
Phoenix shows a warning above the conversation composer and in **Settings → Connections**.

Dismissal hides that reminder only for the current client/server version pair. It does not update
the server.

## Updating

- For a desktop-managed server, update the Phoenix desktop app on the machine that runs it.
- For a source-built command-line server, check out the matching Phoenix revision, rebuild it, stop
  the old process after active work finishes, and relaunch it with the same startup options.

Phoenix does not currently publish a CLI package, so it cannot safely offer an npm command or a
remote background-service update. Never substitute `npx t3`: that installs upstream T3 Code, not
Phoenix.

Updating or restarting interrupts active agent work and terminal commands. Saved threads, settings,
and project files remain on the server machine.

If an update does not resolve the warning:

1. Confirm you updated the server machine named in the warning, not only the device displaying it.
2. Confirm the rebuilt server and client report the same Phoenix version.
3. Relaunch the client after the replacement server is listening.
