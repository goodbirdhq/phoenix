# @phoenix/birdhouse — the birdhouse

The birdhouse is a small, headless service that runs Phoenix's internal business
workflows. Timing is not its job: a Phoenix Schedule fires and starts a thread
whose prompt claims a run over HTTP (see "Which system owns what" below); for
CLI/API-triggered runs, a runner job launches a Claude agent session against
Phoenix's HTTP API instead. Either way the agent posts its result back to an
HTTP callback. Postgres is the source of truth for every run — what was
launched or claimed, and what happened. It is deliberately independent of the
rest of the monorepo, the same way `infra/relay` is: plain TypeScript, no
imports from other workspace packages.

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
    schema.ts         drizzle schema — ops_job, workflow, workflow_run,
                       audit_event
    client.ts         pg Pool + drizzle instance
    migrate.ts        drizzle-kit migration runner
  jobs/
    types.ts          job/handler/lease types, defineJobHandler
    errors.ts         TerminalJobError, JobLeaseLostError
    queue.ts          the durable job queue: enqueue, lease, heartbeat,
                       complete/fail, cancellation, retention, the drain loop
  maintenance/
    tick.ts           one pass: sync workflow definitions from disk, sweep
                       runs past their timeout_at, prune finished jobs — no
                       timing or scheduling; that's Phoenix Schedules' job now
  runner/
    runs.ts           create/cancel a run, and sweepExpiredRuns — the
                       backstop that makes timeout_at mean something even
                       when a run's job chain breaks
    handlers.ts       workflow.launch / workflow.watch / workflow.stop
    prompt.ts         the turn text sent to the agent
    callbackToken.ts  per-run result-callback bearer tokens
  http/
    server.ts         loopback-only: result callback, claim, health, manual
                       trigger
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
  operational toggle (`enabled`) — it never becomes a second place
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

## Which system owns what

Phoenix Schedules own _when_ work happens — one-time or five-field cron, an
IANA timezone, a five-minute minimum interval, DST-correct, managed from the
Phoenix web/desktop/mobile UI. Birdhouse owns _what_ the work is and _what
happened_: workflow definitions, run records, results, the audit
trail. Neither side reaches into the other's job. See
`docs/adr/0003-birdhouse-delegates-timing-to-phoenix-schedules.md` for the
one-line version of why.

### Known gaps in the pull path

Delegating timing to Phoenix Schedules trades birdhouse's own cron for a
few honest gaps, accepted rather than solved:

- **A lost claim response is a rare silent skip.** If the agent's HTTP call
  to `/claim` succeeds but the response never arrives, the agent has nothing
  to retry with — it POSTs again, gets `409 run_in_progress`, and stops. The
  first run just sits open until `timeout_at`. There's no correlation id to
  fix this with: a Schedule's prompt is completely static, and nothing
  tells a session its own thread id.
- **Birdhouse cannot stop a runaway scheduled run.** The timeout sweep marks
  it `timed_out` and audits it, but actually stopping the session needs a
  thread id birdhouse never learns for pull-path runs. The kill switch is
  the Phoenix UI — stop the thread there — then cancel the run in birdhouse
  for bookkeeping. Push-path runs, which do have a `phoenix_thread_id`, are
  unaffected.
- **Scheduled runs have no `phoenix_thread_id`.** Find the thread in Phoenix
  by title (`<schedule name> — <local time>`); Phoenix's own schedule
  history is the authoritative record of which occurrence became which
  thread, not anything in birdhouse's database.
- **Config can drift between the two paths.** A manifest's
  `phoenix.{model, runtime_mode}` block governs push-path runs only. A
  scheduled run is governed by whatever execution config is saved on the
  Phoenix Schedule itself — changing one doesn't touch the other.

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

Everything else in `.env.example` (`BIRDHOUSE_HTTP_PORT`, `BIRDHOUSE_MAINTENANCE_TICK_MS`,
`BIRDHOUSE_WORKFLOWS_DIR`, `BIRDHOUSE_RUN_TIMEOUT_MS`,
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
3. A manifest no longer carries timing — there's no `schedules` field.
   Registering the workflow (step 1) is enough for it to be run manually; to
   put it on a schedule, create a **Phoenix Schedule** instead:

   1. In the Phoenix UI, open `/schedules` (or use the command palette:
      "create schedule"), pointing it at the **Birdhouse** project.
   2. Paste the following as the schedule's prompt, replacing **both**
      occurrences of `<key>`:

      ```
      Run the birdhouse workflow `<key>`. Do this first, before reading or
      exploring anything in the workspace.

      1. In the shell, run:
         curl -sS -X POST http://127.0.0.1:3878/api/workflows/<key>/claim \
           -H 'Content-Type: application/json' -d '{}'
      2. On 200 the response gives you `instructions`, `runId`, `callbackUrl`
         and `callbackToken`. `instructions` is the whole task, and it carries
         its own completion protocol — follow it exactly and invent nothing.
      3. On 409 the workflow is already running: stop immediately and do
         nothing else. Same for any other error — never improvise the task.
      4. Once you have posted your result, stop. Do not start further work.
      ```

      A ready-to-paste version for the `ping` smoke test:

      ```
      Run the birdhouse workflow `ping`. Do this first, before reading or
      exploring anything in the workspace.

      1. In the shell, run:
         curl -sS -X POST http://127.0.0.1:3878/api/workflows/ping/claim \
           -H 'Content-Type: application/json' -d '{}'
      2. On 200 the response gives you `instructions`, `runId`, `callbackUrl`
         and `callbackToken`. `instructions` is the whole task, and it carries
         its own completion protocol — follow it exactly and invent nothing.
      3. On 409 the workflow is already running: stop immediately and do
         nothing else. Same for any other error — never improvise the task.
      4. Once you have posted your result, stop. Do not start further work.
      ```

   3. Settings we use for every birdhouse schedule: timing = cron (five
      fields, at least five minutes apart), timezone `Europe/London`,
      execution = provider instance `claudeAgent`, the cheapest model that
      can actually do the work (`claude-haiku-4-5` for `ping`; a claim ticket
      is a `curl` and a hand-off, so most workflows need far less model than
      their skill implies),
      runtime mode `auto`, interaction `default`, workspace mode **`local`**,
      base branch null. Workspace mode is `local`, not `worktree`: these
      workflows write to Notion and Gmail, never to files, so there's
      nothing to isolate in a worktree, and `worktree` mode would leave one
      worktree per occurrence that Phoenix never cleans up.

   That's the way to create a schedule today, by hand in the UI. Phoenix
   PR #70 (not yet merged) adds a `schedules` toolkit to the per-thread
   `phoenix` MCP server (`list_schedules`, `create_schedule`,
   `run_schedule_now`, etc.), gated behind an `enableScheduleManagement`
   setting — once it lands, you'll be able to just ask a Phoenix agent
   session to create or retime a schedule, and use `run_schedule_now` to
   fire a workflow immediately for testing instead of waiting for cron.
   One gotcha to plan for: those MCP writes derive the project from the
   _calling session's own thread_, never from an argument — so a schedule
   for Birdhouse must be requested from a thread that is itself in the
   Birdhouse project, or it gets created in whatever project you asked
   from, pointing the claim ticket at the wrong workspace. That surface
   also has no delete tool (pausing is the reversible way out) and refuses
   duplicate names.

   The manifest's `workflows/<key>/manifest.json` still governs the run
   itself — `phoenix.{model, runtime_mode}` for push-path runs,
   `input_schema` — just not when it happens.

4. `input_schema` is an opaque JSON Schema document describing the shape a
   run's `input` should have — it documents the contract but isn't enforced
   by the manifest loader itself.

### On or off, and nothing in between

A workflow either runs or it doesn't. `enabled` on the `workflow` row is the
only switch, and `ops enable` / `ops disable` are the only way to move it —
both of which write an audit event.

There is deliberately no dry-run tier. A workflow that wants one asks for it
in its own `input_schema` (a `dryRun` flag its skill defines the meaning of),
because only the workflow knows which of its effects are worth withholding.
The runtime used to carry a `fake`/`shadow`/`live` ladder and it earned its
keep in neither direction: `fake` short-circuited before any Phoenix thread
existed, so it tested less than the `ping` workflow already does, and
`shadow` was a paragraph in the prompt asking the agent not to act — a
request, never a boundary, and one a smaller model has already misread.

Treat "this workflow cannot send email" as a property no code enforces. The
real fix is a per-thread capability allowlist on the Phoenix side; see the
security notes below.

### Manual runs

Without waiting for a Phoenix Schedule to fire:

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
ops list                     # workflows, their enabled state, recent runs
ops run <workflow-key>       # start one run now, printing its id
ops cancel <run-id>          # stop a queued or in-flight run and its session
ops disable <workflow-key>   # stop the workflow being runnable, keep its history
ops enable <workflow-key>    # undo a disable
```

`ops list` no longer has a "NEXT RUN" column — timing lives in Phoenix
Schedules now, not birdhouse; check `/schedules` in the Phoenix UI for that.
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
`workflows.synced`, `maintenance.tick`, `http.request`,
`run.stop_session_failed`, `maintenance.tick_failed`. There's no log
aggregation beyond the systemd journal yet.

## Security notes

- **HTTP bind is loopback-only.** `startHttpServer` binds `127.0.0.1`
  regardless of `BIRDHOUSE_HTTP_PORT` (`src/http/server.ts`) — the callback
  endpoint, health check, the manual-trigger route, and the claim route are
  all only reachable from the box itself. Don't change the bind address
  without adding real auth first (see below).
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
- **The claim route (`POST /api/workflows/:key/claim`) has the same
  shape of no-auth-of-its-own.** It hands out a run's `instructions`, `runId`,
  `callbackUrl` and `callbackToken` to whatever hits it, and relies entirely
  on the loopback bind exactly as `/run` does — anything on this box can
  claim a run for any enabled workflow. Exposing the port beyond loopback
  needs real auth first, same as above.
- **An agent's tools are not scoped per run.** A workflow agent gets
  whatever toolkit the Phoenix harness grants it, and the orchestration
  dispatch contract has no per-thread tool allowlist to narrow it (see
  `docs/phoenix-http-contract.md`). Workflows that research the open web
  therefore read attacker-influenceable text — a prospect's own site, a
  transcript, a CRM field someone else filled in — while holding tools that
  can send mail and write to shared systems. Birdhouse mitigates this from
  its own layer only: the run prompt states that fetched content is data
  rather than instructions and that outward-facing actions need explicit
  workflow authority (`src/runner/prompt.ts`). That is a mitigation, not a
  boundary. Treat "this workflow cannot send email" as a property no code
  enforces today; the real fix is a per-thread capability allowlist on the
  Phoenix side, and until it exists, review a workflow's tool surface before
  enabling it.
