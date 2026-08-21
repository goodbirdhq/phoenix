# Design: run lifecycle, ownership, idempotency

One page on how a workflow run moves through the system, which table owns
what, and why a crash or a retry anywhere in the pipeline can't cause a
duplicate side effect. Read `README.md` first for the setup and workflow-
authoring picture; this is the "how it actually works" companion.

## Run lifecycle

Two paths reach a `workflow_run` row: **push**, where birdhouse itself
starts the agent, and **pull**, where a Phoenix Schedule starts the agent
and the agent then claims a run from birdhouse. See
`docs/adr/0003-birdhouse-delegates-timing-to-phoenix-schedules.md` for why
both exist — birdhouse used to own timing directly (via its own cron) and
now delegates it entirely to Phoenix Schedules.

```
 PUSH                                        PULL
 manual CLI / POST /api/workflows/:key/run   Phoenix Schedule fires
                       │                     (occurrence starts a thread
                       ▼                      whose static prompt is a
              workflow_run: pending           claim ticket)
                       │  (workflow.launch job enqueued,          │
                       │   idempotency key = run:<id>)            ▼
              mode = fake?                          agent POSTs
              ┌────yes─┴───no──┐                     /api/workflows/:key/claim
              ▼                ▼                            │
        succeeded        thread.create           200: workflow_run created
      (stub result,      + thread.turn           directly in `running` —
       no Phoenix         .start                  no job, the caller already
       thread ever        dispatched               IS the agent. Response:
       created)           to Phoenix                {runId, instructions,
                                │                     callbackUrl, callbackToken}
                                ▼                            │
                        workflow_run: running    409 run_in_progress if a
                        (timeoutAt set,           `trigger='schedule'` run
                         workflow.watch           is already open for this
                         job enqueued)             workflow — agent stops.
                                │                            │
                                └──────────────┬─────────────┘
                                                ▼
              ┌─────────────────┬──────────────────┐
              ▼                 ▼                   ▼
        POST /api/runs/   workflow.watch polls  workflow.watch sees
        :id/result        Phoenix, finds a      now() > timeoutAt
        (agent's own      terminal report       with nothing else
        callback)         (success/failure,     terminal yet
                           push only — a pull                  │
                           run has no watch job)                │
              │                 │                   │
              ▼                 ▼                   ▼
        succeeded/failed  succeeded/failed     timed_out
        (completedVia:    (completedVia:       (best-effort
         callback)         report)              stopSession call on push
                                                 runs; pull runs have no
                                                 phoenix_thread_id, so the
                                                 sweep can only mark the
                                                 row — see README's "Known
                                                 gaps in the pull path")
```

`succeeded`, `failed`, `timed_out`, and `cancelled` (cancelled isn't wired
to any producer yet — reserved) are the only terminal states. On the push
path, three producers — the HTTP callback, the watch job reading a Phoenix
report, and the watch job's own timeout check — race to complete a run, and
exactly one wins. A pull-path run has no watch job, so only the callback and
the timeout sweep race for it. See "Idempotency" below for how.

One nuance worth flagging: the schema (`workflow_run_status` enum) and the
guards in `src/http/server.ts`/`src/runner/handlers.ts` both include a
`launching` status, and treat it as an open (non-terminal) state alongside
`pending` and `running`. No code path sets it today — `workflow.launch`
keeps the run at `pending` for its entire body (dispatch idempotency, not
the status column, is what makes a launch retry safe; see below) and moves
straight to `running` once the Phoenix turn has started. It's reserved for
a future in-between state (e.g. "job leased, dispatch in flight") rather
than dead code to remove.

## What each table owns

| Table          | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops_job`      | The durable work queue itself: lease state, retry count/backoff, idempotency key. Two job types drive a run: `workflow.launch` (fires once) and `workflow.watch` (re-enqueues itself with an incrementing `attempt` until the run goes terminal).                                                                                                                                                                                                        |
| `workflow`     | The synced projection of a disk manifest (title, description, skill path, manifest JSON + hash), plus the two operational toggles disk doesn't own: `mode` and `enabled`. Never a second place workflow _logic_ lives — only pointers back to disk plus switches. Carries no timing — that's Phoenix Schedules' data, not birdhouse's.                                                                                                                   |
| `workflow_run` | One launch: trigger, input, current status, result/error, which mode it launched under (frozen at creation — `workflow.mode` can change later without rewriting history), the Phoenix thread id (push-path only — a claimed run has none, see README), the callback token's hash, and the timeout deadline. A partial unique index enforces at most one open `trigger='schedule'` run per workflow. This is the row everything above ultimately updates. |
| `audit_event`  | Append-only record of anything with operational weight: run created, run launched, run completed (and by which path — callback/report/timeout), schedule/mode changes made directly in SQL. Never updated or deleted; not a source of machine state, just the trail.                                                                                                                                                                                     |

## The idempotency story

Every stage that can be retried or replayed has its own idempotency
mechanism — deliberately a different one per stage, because each stage is
retried by a different actor for a different reason:

1. **Job enqueue** (`ops_job.idempotency_key`, unique, push path only).
   `createWorkflowRun` goes through `enqueueJob`, which does `ON CONFLICT DO
NOTHING` on that key and returns the existing row on a race — this is
   what lets `POST /api/workflows/:key/run` accept a caller-supplied
   `dedupeKey` for its own retries. A claimed (pull-path) run never goes
   through this at all: `POST /api/workflows/:key/claim` creates the
   `workflow_run` directly in `running`, with no `workflow.launch` job and
   nothing to enqueue.
2. **Scheduled-run dedupe** (partial unique index on `workflow_run`, scoped
   to `WHERE trigger = 'schedule' AND status IN (open statuses)`). This
   replaced the old scheduler's own `schedule:<scheduleId>:<occurrenceIso>`
   dedupe key, which went away with `src/scheduler/`. A claim while a
   scheduled run is already open for that workflow fails the index and the
   route returns `409 run_in_progress`; the index is deliberately scoped to
   `trigger = 'schedule'` rather than the whole table, so manual runs with
   different inputs can still run in parallel with each other and with a
   scheduled run.
3. **Phoenix dispatch** (deterministic commandIds, `src/runner/ids.ts`).
   `threadId`, `thread.create`'s commandId, `thread.turn.start`'s commandId,
   and the turn's messageId are all deterministic hashes of the run id
   alone — no extra state needs to survive a crash between "built the
   command" and "recorded that it was sent." A `workflow.launch` job retried
   after a crash recomputes the identical ids; Phoenix's own contract
   (`docs/phoenix-http-contract.md` §Idempotency) recognizes the replay and
   returns the original result instead of creating a second thread. The one
   case this can't paper over is a permanent validation rejection (400) —
   the contract says a rejected commandId stays rejected forever, and since
   these ids have no fresh variant to fall back to, a rejection is treated
   as terminal for the run rather than retried (`failRunTerminally` in
   `handlers.ts`).
4. **Guarded terminal transitions** (every completing `UPDATE` is
   `WHERE status IN (open statuses)`). The callback route, the watch job's
   report path, and the watch job's timeout path can all reach the same run
   at nearly the same moment. Each one's `UPDATE ... RETURNING` only
   succeeds if the row is still in an open status; whichever commits first
   wins, and everyone else's `UPDATE` returns no row, which every call site
   reads as "already complete" and treats as a no-op, not an error.
5. **Callback replay** (`callback_token_hash` + open-status check in
   `POST /api/runs/:id/result`). The agent is told to POST its result once,
   but network retries on its end are expected. A replay with a valid token
   against an already-terminal run returns `{alreadyComplete: true}` rather
   than erroring or double-applying the result — same mechanism as #4, from
   the HTTP side. This is unchanged between push and pull: both kinds of run
   complete through the same callback route.

Net effect: nothing in this pipeline needs a distributed lock or a
"has-this-already-happened" side table. Idempotency is structural — unique
keys, deterministic ids, and status-guarded updates — at every hop.

## Deliberate non-features (v1)

- **No retry of a whole run.** If a run fails, times out, or the agent
  never calls back, nothing automatically starts it again. On the push
  path, `workflow.watch` retries _checking on_ a run (with backoff via its
  own job's retry policy), not the run itself; on the pull path there is no
  watch job at all. Re-running is a manual `ops run <key>` today, or waiting
  for the Schedule's next occurrence.
- **No multi-tenant auth.** One operator, one box. Neither the
  manual-trigger route nor the claim route has auth beyond the loopback
  bind (see README's "Security notes"); there's no concept of "who"
  triggered a run beyond the `trigger` enum (`schedule`/`manual`/`api`) and
  the audit log's `actor` string.
- **No correlation between a schedule occurrence and its birdhouse run.**
  A claimed run's `workflow_run` row carries no `phoenix_thread_id`, and a
  Schedule's prompt is static, so nothing links the two beyond timing and
  the workflow key. See README's "Known gaps in the pull path" for the
  operational consequences (finding the thread, stopping a runaway run,
  the lost-response edge case).
- **No capability scoping per run.** Workflow mode (`fake`/`shadow`/`live`)
  and the SKILL's own rules are prose the agent is asked to honour, not a
  sandbox: nothing stops a `shadow` run's agent from calling a write tool,
  because the dispatch contract carries no per-thread tool allowlist. The
  run prompt's "Untrusted content" section narrows the obvious
  prompt-injection path, and `runtime_mode` (global or per-workflow via
  `manifest.phoenix.runtime_mode`) is the only real lever available today.
  Scoping tools per run needs a Phoenix-side change and is the main thing
  standing between this and running untrusted-input workflows in `live`.
- **Report ingestion is best-effort.** The Phoenix HTTP contract itself
  flags this (`docs/phoenix-http-contract.md`, "Notes for the runner"):
  whether a root (non-spawned) thread can post a structured report at all is
  unverified. `workflow.watch` reads it opportunistically as a second
  completion path, but the HTTP callback (`POST /api/runs/:id/result`,
  driven by the skill's own completion protocol) is the primary, relied-on
  result channel. A workflow's skill should never assume the report path
  will fire.
