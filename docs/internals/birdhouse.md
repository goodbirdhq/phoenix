# Birdhouse

Birdhouse is the company's business workflows — prospect research, mailbox
reconciliation, follow-up drafting. It lives in its own repository
(`goodbirdhq/birdhouse`), not in this one. Phoenix touches it in two ways.
Timing: a [Schedule](./schedules.md) triggers an agent thread whose workspace
is a birdhouse checkout, and the thread reads `workflows/<key>/SKILL.md` from
disk and follows it (see
[ADR 0003](../adr/0003-birdhouse-delegates-timing-to-phoenix-schedules.md)).
And reading: the Sales area shows what the birdhouse engine reports, as
described below.

There used to be a service in this repo. `infra/birdhouse` was a headless Node
process with its own Postgres that served workflow definitions over a claim
endpoint, tracked runs in a table, took results back on a callback, and drove
Phoenix from the outside over the orchestration HTTP API. It is gone — see
[ADR 0004](../adr/0004-birdhouse-runtime-retired.md). A thread that already
sits in the checkout does not need the definition served to it, and the
bookkeeping the runtime existed to do is better done where the work lands.

## What this means for Phoenix maintainers

**Threads a birdhouse Schedule triggers are ordinary threads.** They appear in
the UI, hold a real provider session, and count against the same provider
quota. Nothing about them is privileged, and no code path treats them
specially.

**Phoenix's health signal stops at the trigger.** A Schedule that cannot
trigger its Occurrence records `unacknowledgedFailure` on itself, and that is
the whole of what Phoenix knows — consistent with
[ADR 0002](../adr/0002-schedules-end-at-durable-thread-trigger.md). Whether a
workflow actually did its job, and did it once, is answered in the workflow's
own domain: a CRM stage it sets before starting, a Gmail message id it matches
on. That is deliberate. Resist adding run records here to answer it.

**Phoenix knows a sales engine, not birdhouse.** The Sales area reads the
birdhouse engine's API and relays its actions, but the code calls it a sales
engine: a generic `sales` module whose adapter
(`apps/server/src/sales/SalesEngineApi.ts`) is the only place the engine's paths
and answers are known. It stores no sales records; the engine and Notion stay
the truth. See [ADR 0005](../adr/0005-sales-engine-adapter.md). Approvals are
signed on a device, never by the server: see [Sales approvals](./sales-approvals.md).

**Dispatch follows the agents repo's contract, in one file.** Research this and
Redraft with notes start a thread in the configured sales agents project with
the prompt birdhouse's README gives under "Dispatching a skill". That prompt and
the skill keys it names live only in `apps/server/src/sales/SalesDispatch.ts`;
when birdhouse changes its dispatch table, that file changes with it. Run
records and other birdhouse specifics still do not belong in `apps/` or
`packages/`.
