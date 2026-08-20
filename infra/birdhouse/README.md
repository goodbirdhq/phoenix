# @phoenix/birdhouse — the birdhouse

The birdhouse is a small, headless service that runs Phoenix's internal business
workflows: a scheduler enqueues durable jobs on a cron, a runner job launches
a Claude agent session against Phoenix's HTTP API, and the agent posts its
result back to an HTTP callback. Postgres is the source of truth for every
run — what was scheduled, what launched, what happened. It is deliberately
independent of the rest of the monorepo, the same way `infra/relay` is: plain
TypeScript, no imports from other workspace packages.

## Local setup

1. Create the database on the shared local Postgres:
   ```sh
   createdb birdhouse
   ```
2. Copy `.env.example` to `.env.local` and adjust `BIRDHOUSE_DATABASE_URL` if your
   local Postgres isn't on the default port.
3. Apply migrations:
   ```sh
   pnpm --dir infra/birdhouse migrate
   ```
4. Run the worker:
   ```sh
   pnpm --dir infra/birdhouse dev
   ```

Required env vars are validated at startup (`src/config.ts`); see
`.env.example` for the full list and defaults.

## Layout

```
src/
  config.ts           env validation (zod)
  cli.ts              entry point: worker | migrate | run | list | enable |
                       disable | cancel
  db/
    schema.ts         drizzle schema — ops_job, workflow, workflow_schedule,
                       workflow_run, audit_event
    client.ts         pg Pool + drizzle instance
    migrate.ts        drizzle-kit migration runner
  jobs/
    types.ts          job/handler/lease types, defineJobHandler
    errors.ts         TerminalJobError, JobLeaseLostError
    queue.ts          the durable job queue: enqueue, lease, heartbeat,
                       complete/fail, cancellation, retention, the drain loop
  scheduler/
    tick.ts           one pass: sync definitions from disk, sweep runs past
                       their deadline, prune finished jobs, claim due
                       schedules and start their runs
  runner/
    runs.ts           create/cancel a run, and sweepExpiredRuns — the
                       backstop that makes timeout_at mean something even
                       when a run's job chain breaks
    handlers.ts       workflow.launch / workflow.watch / workflow.stop
    prompt.ts         the turn text sent to the agent
    callbackToken.ts  per-run result-callback bearer tokens
  http/
    server.ts         loopback-only: result callback, health, manual trigger
  phoenix/
    client.ts         PhoenixClient interface + createPhoenixClient
  workflows/
    loader.ts         read manifests from disk, project them into the DB
drizzle/              generated SQL migrations
```

Every module has a `*.test.ts` beside it. Tests that need Postgres are gated
on `BIRDHOUSE_TEST_DATABASE_URL` and skip without it.

## Design principles

- **The repo owns definitions; Postgres owns machine state.** A workflow's
  behaviour lives in its skill manifest on disk, versioned like any other
  code. The `workflow` table is a synced projection of that manifest plus
  operational toggles (`mode`, `enabled`) — it never becomes a second place
  workflow logic lives.
- **Every external effect is idempotent.** Jobs carry an `idempotency_key`;
  enqueuing the same unit of work twice returns the existing row rather than
  creating a duplicate or erroring. Handlers that call out to Phoenix or
  anywhere else must be safe to run more than once for the same job.
- **Jobs use the SQL clock.** Every due/lease comparison (`run_after`,
  `lease_until`) runs as SQL against Postgres's `now()`, never a JS `Date`
  compared client-side — the two clocks can disagree, and a job enqueued a
  moment ago must never look "not yet due" because of it.
- **Boring, well-factored code, sized to what exists today.** This is
  infrastructure meant to be extended for years by one person; no
  speculative abstraction for workflows that don't exist yet.

## Running on the box

This assumes the birdhouse is running alongside Phoenix on the same box, the
way it does in production today.

### Pairing with Phoenix

The birdhouse launches agent threads through Phoenix's HTTP API, which needs a
bearer token. Mint one once (see `docs/phoenix-http-contract.md` for the
full contract):

```sh
phoenix pair --label "birdhouse"
```

This prints a single-use credential with a 5-minute TTL. Exchange it
immediately for a real access token:

```sh
curl -s -X POST "$PHOENIX_BASE_URL/oauth/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token=<credential from phoenix pair> \
  -d subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap \
  -d requested_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d "scope=orchestration:read orchestration:operate" \
  -d client_label=birdhouse-service
```

The response is `{access_token, token_type: "Bearer", expires_in: 2592000,
scope}` — a token good for 30 days.

The token lives in `~/.phoenix/userdata/secrets/birdhouse-token`, as a single
`PHOENIX_BIRDHOUSE_TOKEN=<access_token>` line — that file doubles as the
`EnvironmentFile` the systemd unit loads (see "Operations" below), so
pairing again is just overwriting this one file. Keep it `chmod 600`.

### Required environment

The real values used on this box:

```sh
BIRDHOUSE_DATABASE_URL="postgresql://projectx:<password>@localhost:5433/birdhouse"
PHOENIX_BASE_URL="http://100.68.224.90:3874"
PHOENIX_BIRDHOUSE_TOKEN="<from pairing, above>"
PHOENIX_PROVIDER_INSTANCE_ID="claudeAgent"
PHOENIX_MODEL="claude-fable-5"
PHOENIX_PROJECT_ID="<see below>"
```

`PHOENIX_PROJECT_ID` isn't discoverable by name over HTTP — fetch it once
and paste it in:

```sh
curl -s "$PHOENIX_BASE_URL/api/orchestration/snapshot" \
  -H "Authorization: Bearer $PHOENIX_BIRDHOUSE_TOKEN" | jq
```

Look for the project whose `workspaceRoot` is this box's ops/business repo
checkout.

Everything else in `.env.example` (`BIRDHOUSE_HTTP_PORT`, `BIRDHOUSE_SCHEDULER_TICK_MS`,
`BIRDHOUSE_TIMEZONE`, `BIRDHOUSE_WORKFLOWS_DIR`, `BIRDHOUSE_RUN_TIMEOUT_MS`,
`BIRDHOUSE_RUN_WATCH_INTERVAL_MS`) has a sane default; only override on the box if
you have a specific reason to.

### Database

The birdhouse's Postgres lives in the shared `projectx-postgres` container
(`localhost:5433`, user `projectx`), not a dedicated instance — it's a
database inside that container, not a separate container:

```sh
createdb -h localhost -p 5433 -U projectx birdhouse
```

Then, from `infra/birdhouse`:

```sh
pnpm migrate
```

### Running the worker

```sh
pnpm --dir infra/birdhouse dev
```

For anything longer than a foreground test, run it under systemd — see
"Operations" below.

## Adding a workflow

1. Create `workflows/<key>/manifest.json` and `workflows/<key>/SKILL.md`.
   `<key>` must match `^[a-z0-9][a-z0-9-]*$` and match the manifest's own
   `key` field — see `src/workflows/manifest.ts` for the full schema, and
   `workflows/ping/` or `workflows/prospect-research/` for worked examples.
2. `skill` in the manifest is a path to the skill file, relative to the
   workflow's own directory (almost always just `"SKILL.md"`).
3. `schedules` is a list of cron triggers, each `{cron, timezone, enabled}`
   (`timezone` defaults to `BIRDHOUSE_TIMEZONE`, `enabled` defaults to `true`).
   Leave it `[]` to register the workflow without any automatic trigger —
   it can still be run manually. The scheduler resyncs `workflows/` from
   disk into the `workflow` / `workflow_schedule` tables on every tick
   (`BIRDHOUSE_SCHEDULER_TICK_MS`, 15s by default) — editing a manifest or adding
   a schedule takes effect on the next tick, no restart or migration needed.
4. `input_schema` is an opaque JSON Schema document describing the shape a
   run's `input` should have — it documents the contract but isn't enforced
   by the manifest loader itself.

### The mode ladder

Every workflow has a `mode`: `fake`, `shadow`, or `live`, stored on the
`workflow` row (not the manifest — it's an operational toggle, flipped
without a deploy or a disk change).

- **`fake`** — `workflow.launch` short-circuits: no Phoenix thread is ever
  created, the run is marked `succeeded` immediately with a stub result.
  Use it to test that scheduling and job wiring work end-to-end without
  spending an agent turn.
- **`shadow`** — a real agent thread runs, but the birdhouse tells it (in the
  prompt, automatically) not to perform any external side effect — record
  what it would have done instead. **New workflows default to `shadow`.**
- **`live`** — the agent performs real side effects (sends, writes,
  drafts). Flip a workflow to `live` only once you trust its shadow-mode
  output, by updating the `mode` column on its `workflow` row directly:

  ```sql
  update workflow set mode = 'live' where key = '<key>';
  ```

  (No CLI for this yet — it's a rare, deliberate action; a raw `UPDATE` is
  fine at this scale.)

### Manual runs

Without waiting for a schedule:

```sh
pnpm --dir infra/birdhouse exec tsx src/cli.ts run <key> --input '{"prospect": {"company": "Acme"}}'
```

or, with the worker already running:

```sh
curl -X POST http://127.0.0.1:3878/api/workflows/<key>/run \
  -H 'Content-Type: application/json' \
  -d '{"input": {"prospect": {"company": "Acme"}}}'
```

Both print/return a `runId`; `pnpm --dir infra/birdhouse exec tsx src/cli.ts list`
shows recent runs and their status.

## Operations

### Everyday commands

```sh
ops list                     # workflows, their next occurrence, recent runs
ops run <workflow-key>       # start one run now, printing its id
ops cancel <run-id>          # stop a queued or in-flight run and its session
ops disable <workflow-key>   # stop scheduling it, keep it and its history
ops enable <workflow-key>    # undo a disable
```

`enable` is also how you recover from an automatic disable: when a workflow
stops appearing on disk, reconciliation disables it, and the sync never
re-enables anything on its own.

### Token expiry

The Phoenix bearer token expires 30 days after pairing. There's no
automated renewal or expiry alert yet (a connector-health workflow is the
planned fix — see `docs/design.md`'s non-features and the company-OS plan).
Until then: re-pair manually (see "Pairing with Phoenix" above) before the
30 days are up, or the next `workflow.launch` job will start failing with
Phoenix auth errors.

### The worker as a systemd service

```ini
# /etc/systemd/system/birdhouse.service
[Unit]
Description=Phoenix birdhouse worker
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/path/to/phoenix/infra/birdhouse
EnvironmentFile=/home/<user>/.phoenix/userdata/secrets/birdhouse-token
EnvironmentFile=/path/to/phoenix/infra/birdhouse/.env.production
ExecStart=/usr/bin/pnpm exec tsx src/cli.ts worker
# (WorkingDirectory above makes this equivalent to `pnpm --dir infra/birdhouse exec tsx src/cli.ts worker`)
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Two `EnvironmentFile`s: the token file (just `PHOENIX_BIRDHOUSE_TOKEN=...`,
updated independently on re-pair) and a regular `.env` for everything else
in "Required environment" above. Order matters if a key appears in both —
later files win.

### Logs

Every log line is one JSON object (`console.log`/`console.warn` of
`JSON.stringify({event, ...})`) — `journalctl -u birdhouse -f | jq` to follow
it structured. Notable `event` values: `worker.started`, `worker.stopped`,
`workflows.synced`, `scheduler.tick`, `http.request`,
`run.stop_session_failed`, `scheduler.run_start_failed`,
`scheduler.tick_failed`. There's no log aggregation beyond the systemd
journal yet.

## Security notes

- **HTTP bind is loopback-only.** `startHttpServer` binds `127.0.0.1`
  regardless of `BIRDHOUSE_HTTP_PORT` (`src/http/server.ts`) — the callback
  endpoint, health check, and manual-trigger route are all only reachable
  from the box itself. Don't change the bind address without adding real
  auth first (see below).
- **Callback tokens are hashed at rest.** Each run gets a single-purpose
  bearer token for its result callback; only its sha256 hash is stored on
  the `workflow_run` row (`callback_token_hash`). The raw token exists only
  in the `workflow.launch` job's payload (same trusted database) and in the
  prompt sent to the agent — it's never logged. See
  `src/runner/callbackToken.ts`.
- **The manual-trigger route (`POST /api/workflows/:key/run`) has no
  auth of its own.** It relies entirely on the loopback bind: anything that
  can reach `127.0.0.1:$BIRDHOUSE_HTTP_PORT` on this box can start any enabled
  workflow. That's an accepted tradeoff for a same-box CLI/script trigger
  in v1 — it is not safe to expose beyond loopback as-is.
- **An agent's tools are not scoped per run.** A workflow agent gets
  whatever toolkit the Phoenix harness grants it, and the orchestration
  dispatch contract has no per-thread tool allowlist to narrow it (see
  `docs/phoenix-http-contract.md`). Workflows that research the open web
  therefore read attacker-influenceable text — a prospect's own site, a
  transcript, a CRM field someone else filled in — while holding tools that
  can send mail and write to shared systems. Birdhouse mitigates this from
  its own layer only: the run prompt states that fetched content is data
  rather than instructions and that outward-facing actions need explicit
  workflow authority (`src/runner/prompt.ts`), and new workflows default to
  `shadow`. Those are mitigations, not a boundary. Treat "this workflow
  cannot send email" as a property no code enforces today; the real fix is a
  per-thread capability allowlist on the Phoenix side, and until it exists,
  review a workflow's tool surface before flipping it to `live`.
