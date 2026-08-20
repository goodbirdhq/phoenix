# Schedule architecture

> For maintainers. Using Phoenix? See [Schedule agent work](../user/schedules.md).

Schedules are environment-owned orchestration. The server that owns an environment is the only
authority that persists Schedule definitions, evaluates timing, claims Occurrences, and performs
Triggers. Clients query and cache Schedule state, but never drive timing or mutate an offline
environment. This follows [ADR 0001](../adr/0001-environments-own-schedules.md).

## Domain boundary

A Schedule stores a name, text prompt, Project reference, one-time or recurring timing rule,
explicit IANA time zone, and explicit provider/model/runtime/interaction/workspace configuration.
Environment ownership is immutable. Cross-environment duplication is a read from the source and a
new create command on the online destination.

An Occurrence identifies one due attempt. Its durable, collision-resistant identity is reserved
before side effects and also scopes deterministic command, worktree, and temporary branch identity.
That lets recovery replay an ambiguous Trigger without creating a second Thread.

A Trigger ends when Phoenix has durably created a fresh Thread and accepted its first Turn. The
environment-wide Trigger permit is released at that point; provider execution and all later Thread
behavior are outside the Schedule domain. This follows
[ADR 0002](../adr/0002-schedules-end-at-durable-thread-trigger.md).

## Timing and recovery

The scheduling reactor reads durable next-due state and sleeps on the Effect clock until either that
instant or a Schedule mutation wakes it. It does not continuously poll and does not allocate one
timer per Schedule. Migrations and projections are ready before the reactor starts.

One-time rules resolve to one instant. Recurring rules are standard five-field cron expressions
evaluated in the saved time zone with a minimum five-minute interval. Nonexistent daylight-saving
wall times are skipped, and repeated wall times produce one Occurrence.

At startup and after a wake, overdue calculation retains only the newest Missed Occurrence for each
Schedule. Older ticks become a compact skipped count and time range. Retained Occurrences across
Schedules are claimed oldest-first with stable Schedule creation order as the tie-breaker.

Catch-up classifies due definitions and Triggers durable Occurrences in bounded pages, releasing
mutation and Trigger permits between pages so commands can proceed. For many overdue recurring Occurrences,
exact retained-oldest ordering can require classifying every due Schedule before the first Trigger:
the stored next-due instant is the first missed tick, while the retained candidate is the newest
missed tick. Do not replace that safety frontier with page-local ordering, which can Trigger a newer
Occurrence before an unseen older retained candidate.

Only one Trigger owns the environment permit at a time. The claim, deterministic Thread bootstrap,
and Trigger bookkeeping are replay-safe across crashes before claim, during preparation, after
Thread creation, and after commit. A pre-Trigger failure is recorded once and is not automatically
retried; a recurring Schedule remains eligible at its next Occurrence.

## Reads, caching, and authorization

Schedule list, detail, and compact history use their own environment-scoped query and subscription
rather than joining the ordinary live shell payload. This keeps high-frequency history away from
Thread navigation and startup snapshots.

Definitions and Occurrence execution snapshots do not embed the growing history array. History is
stored in an indexed, environment-local table and read through opaque cursor pages. Detail returns
only the newest bounded page; clients page older entries on demand and cap their active render
window. This keeps a five-minute Schedule linear in durable storage and bounded in network and UI
work.

The shared client runtime aggregates live and cached records from known environments. Web stores
last-seen Schedule data in IndexedDB and mobile stores it in SQLite through the environment cache
boundary. Cached data is visibly read-only and cannot create Occurrences. Live snapshots always win
over older cached values, and removing an environment clears its Schedule cache.

Reads and subscriptions require `orchestration:read`. Create, update, pause, resume, delete, Run
now, and failure acknowledgement require `orchestration:operate`. Schedules introduce no new
administrator-only capability and no provider-specific execution path.

## Testing boundary

The primary behavioral seam drives public Schedule commands through real persistence, migrations,
projections, durable queries, and the scheduling reactor with a controllable Effect clock. Only the
final Thread bootstrap boundary is replaced with a recording or failing test implementation. Tests
assert public Schedule snapshots, compact history, and recorded Thread launches rather than private
timers, fibers, queues, or SQL.

Use explicit reactor drains or typed receipts instead of sleeps. Thin tests cover contract encoding,
authorization, cache reconciliation, client navigation, and VCS identity. All server tests use
isolated worktree-local Phoenix state; the live Phoenix installation and its database are never test
targets.
