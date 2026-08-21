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

## Agent access (schedules MCP toolkit)

`apps/server/src/mcp/toolkits/schedules/{tools,handlers}.ts` exposes six tools on the per-thread
`phoenix` MCP server: `list_schedules`, `get_schedule`, `create_schedule`, `update_schedule`,
`set_schedule_state`, and `run_schedule_now`. Handlers call `ScheduleService.dispatch` directly, so
agent writes take the same command-decider-projector path as the UI; nothing bypasses the domain.

Three properties shape the surface:

**Project is derived, never passed.** Writes resolve the calling session's thread through
`ProjectionSnapshotQuery` and use its `projectId`, so an agent cannot author automation into a
project it is not working in. There is no `projectId` parameter to get wrong. Execution settings
default from the same shell, which makes them provably runnable in this environment; `model` and
`workspaceMode` are the only overrides. Reads may widen to every project with `allProjects: true`,
because "what have I got scheduled" should not depend on which project a session is in. For the same
reason `get_schedule` is not project-scoped at all: an id that came back from a widened list has to
stay readable. Reads are gated by the capability and the settings toggle, not by project.

**Updates are patches over a whole-definition command.** `schedule.update` carries a complete
definition. The handler reads the stored detail, merges the fields the caller sent, and dispatches
the result, so editing a Schedule's time never requires resending a 120k-character prompt the agent
never read. This is last-write-wins against a concurrent UI edit; the `revision` field is available
if that ever needs tightening.

**No delete, and pause is the way out.** The domain has `schedule.delete`; this toolkit does not
expose it. An agent that misreads a request can pause a Schedule, which the user can undo in one
click, but cannot destroy one. For the same reason `create_schedule` refuses a name already used by
an enabled or paused Schedule in that project and returns the colliding id: a duplicate is something
this surface cannot clean up. `schedule.acknowledge-failures` is likewise withheld — clearing a
failure badge is the user saying they have seen it.

Gating stacks the way the other toolkits do: a `schedules` capability on the MCP credential, then
`enableScheduleManagement` read per call so flipping it reaches running sessions. Reads are gated
with writes; a half-on state is harder to reason about than either end.

Every write returns the next `SCHEDULE_UPCOMING_OCCURRENCE_COUNT` occurrences and the cadence in
plain language, because `0 6 * * 1-5` and `0 6 * * 1,5` differ by one character and mean completely
different things. Aggressive cadences also return a thread-count warning; the five-minute floor
stays in the domain rather than being duplicated here.

### Chat rows

`packages/shared/src/scheduleToolActivity.ts` reduces a write result to the six fields a chat row
renders, and `ActivityPayloadProjection` carries it as `data.scheduleActivity`. This is necessary,
not decorative: the projection drops `result` from MCP items and summarizes tool output to 84
characters, which would cut the Schedule's id and cadence out entirely. The five upcoming
occurrences are deliberately _not_ carried — they are for the agent to read back in prose, and
putting them on the wire for every write would be payload bloat.

Web renders `ScheduleWriteRow` in `MessagesTimeline.tsx`; mobile gives the row a rewritten heading,
a calendar icon, and a cadence preview in `threadActivity.ts`, matching how `spawn_session` is
handled on each surface. Both are static receipts built from the tool result — a live subscription
per historical row would cost real work on long threads and would misreport history by showing a
Schedule's state today next to the moment it was created. The row links to the Schedules page, which
is the live view. Failed writes fall through to the generic tool row, where the error is visible on
expand.

Provider coverage for the row is currently **Claude and Codex only**, and this is a known gap
rather than a decision. `deriveScheduleToolActivity` recognizes two payload shapes: Codex's
`item.server`/`item.tool` pair, and Claude's flattened `mcp__phoenix__*` tool name. OpenCode
classifies tool items by substring on the tool name (`toToolLifecycleItemType`), and Cursor and Grok
arrive over ACP, where anything that is not execute/edit/search maps to `dynamic_tool_call` — so the
MCP projection path never runs for them at all. The tools themselves work on every provider; only
the row is missing, and those threads fall back to the generic expandable tool row, which still
shows the call and its arguments. Closing this needs the real tool-name strings each adapter emits,
confirmed against a live session per provider rather than inferred from adapter source.

The cadence humanizer is `packages/shared/src/scheduleCadence.ts`. It names common shapes and falls
back to the raw expression rather than guessing, on the grounds that a confident wrong sentence is
worse than cron.

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
