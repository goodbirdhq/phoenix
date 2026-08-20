# @phoenix/ops — the ops hub

The ops hub is a small, headless service that runs Phoenix's internal business
workflows: a scheduler enqueues durable jobs on a cron, a runner job launches
a Claude agent session against Phoenix's HTTP API, and the agent posts its
result back to an HTTP callback. Postgres is the source of truth for every
run — what was scheduled, what launched, what happened. It is deliberately
independent of the rest of the monorepo, the same way `infra/relay` is: plain
TypeScript, no imports from other workspace packages.

## Local setup

1. Create the database on the shared local Postgres:
   ```sh
   createdb phoenix_ops
   ```
2. Copy `.env.example` to `.env.local` and adjust `OPS_DATABASE_URL` if your
   local Postgres isn't on the default port.
3. Apply migrations:
   ```sh
   pnpm --dir infra/ops migrate
   ```
4. Run the worker:
   ```sh
   pnpm --dir infra/ops dev
   ```

Required env vars are validated at startup (`src/config.ts`); see
`.env.example` for the full list and defaults.

## Layout

```
src/
  config.ts          env validation (zod)
  cli.ts              entry point: worker | migrate | run <key> | list
  db/
    schema.ts          drizzle schema — ops_job, workflow, workflow_schedule,
                        workflow_run, audit_event
    client.ts           pg Pool + drizzle instance
    migrate.ts           drizzle-kit migration runner
  jobs/
    types.ts             job/handler/lease types, defineJobHandler
    errors.ts             TerminalJobError, JobLeaseLostError
    queue.ts              the durable job queue: enqueue, lease, heartbeat,
                           complete/fail, cancellation, the drain loop
    queue.test.ts          unit tests (retry policy, terminal-error
                            classification) + DB tests gated on
                            OPS_TEST_DATABASE_URL
  scheduler/
    tick.ts               runSchedulerTick(db) — stub, next wave
  phoenix/
    client.ts              PhoenixClient interface + createPhoenixClient —
                            stub, seam for the Phoenix-side integration
drizzle/                  generated SQL migrations
```

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
