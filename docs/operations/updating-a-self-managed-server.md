# Updating a Self-Managed Phoenix Server

> For whoever runs the server. Using the desktop app to host? Update the desktop app instead — see
> [Keeping app and server in sync](../user/updating.md).

Phoenix has no owned npm package, so `phoenix service install` and `phoenix service update` are
disabled and `npx t3` installs a different product. That leaves one supported shape for a
long-running server: a source checkout you build yourself, launched from a terminal or from a
service definition you own. This runbook updates that server and proves the update took.

The whole procedure is: know what you are running, rebuild, restart onto it, confirm it changed.

## 1. Find out what the service actually runs

Do this first even if you think you know. A unit usually points at a launcher script rather than at
Node directly, and the path it ends up executing is the thing you have to rebuild.

```sh
systemctl --user cat phoenix.service
```

Follow `ExecStart` until it names a JavaScript entry point. A typical chain ends at a build output
inside a checkout:

```sh
# ExecStart=/home/you/.local/bin/phoenix-serve
cat /home/you/.local/bin/phoenix-serve
# exec node /home/you/code/phoenix/apps/server/dist/bin.mjs serve --host ...
```

Two things follow from that path, and both bite people:

- **The build output is the live install.** Rebuilding the checkout replaces what the service
  executes. A running process keeps the copy it loaded at start, so nothing changes until a
  restart — but the next restart picks up whatever is in `dist/` at that moment, intended or not.
- **Building from a dirty tree ships uncommitted work.** If the checkout has local changes when you
  build, those changes go live on the next restart.

## 2. Record what you are on

```sh
node /home/you/code/phoenix/apps/server/dist/bin.mjs --version
```

```
phoenix v0.0.33 (b421b138)
```

The value in parentheses is the commit the binary was built from. Some answers are not a usable
revision, and each means something specific:

| Output             | Meaning                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `(b421b138)`       | Built from that commit, clean tree.                                                            |
| `(b421b138-dirty)` | Built from that commit **plus uncommitted changes**. Not a revision anyone else can reproduce. |
| `(source)`         | Running from `src/`, not a build.                                                              |
| `(unknown commit)` | Built where git could not answer, e.g. a checkout with no `.git`.                              |

Write the commit down. It is what you compare against in step 6 and what you roll back to in step 7.

## 3. Update the checkout

Restarting interrupts in-flight agent turns and terminal commands, so pick a moment when nothing is
mid-run.

```sh
cd /home/you/code/phoenix
git status --porcelain     # must be empty, or you are about to ship local changes
git fetch origin
git checkout main
git pull --ff-only
```

To pin a specific revision instead of tracking `main`, `git checkout <tag-or-sha>` here.

## 4. Rebuild

```sh
vp i
vp run --filter t3 build
```

`vp i` is required whenever dependencies moved; skipping it produces module-resolution failures that
look like unrelated bugs. The build task builds the web client before the server, so the UI is
rebuilt too — skipping it leaves a stale UI served by a new backend.

The running server is unaffected by this: it keeps executing the copy it loaded at start. Only the
restart in the next step switches it over, which is why the build comes first — a failed build costs
no downtime, and you should not restart onto one.

## 5. Stop, snapshot the database, start

Threads, settings, and secrets live in the T3 home directory (`~/.phoenix` by default), not in the
checkout, so a rebuild does not touch them. A server does run migrations on start, though, and
migrations are one-way. Snapshot before the restart that applies them.

Take the copy while the server is stopped. A live copy is a corrupt copy: SQLite keeps recent
committed data in the `-wal` sibling, so copying `state.sqlite` alone from a running server silently
loses it.

```sh
systemctl --user stop phoenix.service

cp ~/.phoenix/userdata/state.sqlite      /tmp/phoenix-backup.sqlite
cp ~/.phoenix/userdata/state.sqlite-wal  /tmp/phoenix-backup.sqlite-wal 2>/dev/null || true
cp ~/.phoenix/userdata/state.sqlite-shm  /tmp/phoenix-backup.sqlite-shm 2>/dev/null || true

systemctl --user start phoenix.service
systemctl --user status phoenix.service
```

The `-wal` and `-shm` files may not exist after a clean shutdown, which is why their copies are
allowed to fail. Copy all three whenever they are present, and keep them together — a snapshot
missing its `-wal` is not restorable.

## 6. Confirm the update took

```sh
node /home/you/code/phoenix/apps/server/dist/bin.mjs --version
```

The commit must differ from what you recorded in step 2. If it is unchanged, the build did not
replace the file the unit executes — recheck the path in step 1. If it gained a `-dirty` suffix,
the tree was not clean when you built.

Then confirm from a client: the version warning above the composer and in **Settings → Connections**
clears once client and server agree. Reload the client after the server is listening again.

## 7. Roll back

Nothing about this is special — it is steps 3 to 5 against the old commit:

```sh
cd /home/you/code/phoenix
git checkout <the commit from step 2>
vp i && vp run --filter t3 build
systemctl --user restart phoenix.service
```

Restore the database only if a migration ran and you need the old schema. With the server stopped,
put all three snapshot files back, and delete any `-wal`/`-shm` left behind by the newer server so
SQLite cannot replay a journal against a database it no longer matches.

## What not to do

- `npx t3@latest` and the `t3` npm package install **upstream T3 Code**, a different product.
- `phoenix service install` / `phoenix service update` target a package distribution Phoenix does
  not have. See [Background service](../user/background-service.md).
- Do not build in a checkout with uncommitted work you did not mean to deploy. `--version` reports
  it afterwards, but only after it is already live.
