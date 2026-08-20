# Birdhouse

Birdhouse runs the company's business workflows as Phoenix agent threads. It
is a headless service with its own process and its own Postgres, living at
`infra/birdhouse` — the same shape as `infra/relay`, and like relay it is not
part of the app the user installs.

The code and its own reference docs live with the service:

- [`infra/birdhouse/README.md`](../../infra/birdhouse/README.md) — setup,
  everyday commands, running it on the box, security notes.
- [`infra/birdhouse/docs/design.md`](../../infra/birdhouse/docs/design.md) —
  run lifecycle, what each table owns, the idempotency story, and the
  deliberate non-features.
- [`infra/birdhouse/docs/phoenix-http-contract.md`](../../infra/birdhouse/docs/phoenix-http-contract.md)
  — the wire contract it depends on.

This page covers what a Phoenix maintainer needs to know without reading any
of that.

## Why it is a separate service

Birdhouse drives Phoenix from the outside, over the same HTTP API any other
client uses. It has no privileged access, shares no process, and nothing in
`apps/` or `packages/` imports it. Business workflows — the schedules they
run on, the CRM they write to, the voice their drafts are written in — change
on a different cadence from the product, and coupling them into the server's
own orchestration would put that churn inside the app every user runs.

The trade-off is that birdhouse depends on an interface rather than on types.
See "The contract it depends on" below.

## How a run works

One `workflow_run` row per unit of work. The scheduler claims a due schedule
(or an operator runs `ops run <key>`), which creates the run and enqueues a
durable job; that job launches a real Phoenix thread and starts a turn; a
watch job polls it; and the agent reports its result by POSTing to a
loopback-only callback whose per-run bearer token was minted at creation.

Three things can complete a run — the callback, a session report the watch job
reads, or a timeout — and each is a guarded conditional update, so exactly one
wins. A run past its deadline is retired by a sweep on the scheduler's
cadence, deliberately outside the job chain, so a broken chain can't strand a
run in a non-terminal state.

## What this means for Phoenix maintainers

**The orchestration HTTP API is birdhouse's dependency.** It calls
`POST /api/orchestration/dispatch` (`thread.create`, `thread.turn.start`,
`thread.session.stop`) and `GET /api/orchestration/threads/:id`. Those shapes
are hand-transcribed into `infra/birdhouse/src/phoenix/client.ts` and recorded
in its contract doc, because birdhouse takes no workspace dependencies — which
means **a change to those commands or their responses will not fail birdhouse's
typecheck**. It fails at runtime, on the box, the next time a workflow runs.
If you change the dispatch contract, the thread detail response, or the
orchestration error bodies, update that client in the same PR.

**Agent threads it launches are ordinary threads.** They appear in the UI,
they hold a real provider session, and they count against the same provider
quota. A thread titled `<workflow> — run <uuid>` belongs to birdhouse.

**Scheduling overlaps with environment-owned agent schedules** (`apps/server/src/schedule/`),
which landed after birdhouse was written. Both turn a cron occurrence into an
agent turn; they use different cron implementations and disagree on DST edge
cases. Consolidating them is open work — see design.md's non-features.

**Nothing in the app should import from `infra/birdhouse`.** It is a consumer
of Phoenix, not a part of it.

## Vocabulary

Birdhouse terms, and how they line up with the [glossary](./glossary.md):

| Birdhouse term | Meaning                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow       | A directory of `manifest.json` + `SKILL.md` defining a repeatable unit of business work. The repo owns the definition; the database owns its `mode` and `enabled`.                                                                  |
| run            | One execution of a workflow. Backed by a `workflow_run` row, and drives exactly one Phoenix **thread** and one **turn** in the glossary's sense.                                                                                    |
| workflow mode  | `fake` \| `shadow` \| `live` — how far a run's side effects are allowed to go. Distinct from the glossary's **runtime mode**, which is the Phoenix permission mode the launched thread runs under. New workflows start in `shadow`. |
| shadow run     | A run whose agent is instructed to record what it would have done instead of doing it. Prose, not a sandbox — see design.md's non-features.                                                                                         |
| job            | A row in birdhouse's own durable queue. Unrelated to anything in the app.                                                                                                                                                           |
