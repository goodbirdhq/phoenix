# Session Orchestration

How a running agent session spawns and coordinates sibling threads. User-facing behavior:
`docs/user/session-orchestration.md`.

## Shape

The feature rides the existing MCP ingress and the event-sourced command path; no new protocol or
transport. A session calls tools on the per-thread `phoenix` MCP server, the handlers dispatch
ordinary orchestration commands, and the provider adapters do what they always do.

```
agent session ── MCP tool call ──> apps/server/src/mcp/toolkits/sessions/{tools,handlers}.ts
                                      │  requireMcpSessionsCapability + enableSessionOrchestration
                                      ├─ spawn_session ──> ThreadTurnBootstrap.bootstrapTurnStart
                                      │     (thread.create with spawnedByThreadId → worktree →
                                      │      setup script → first turn; rollback on failure)
                                      ├─ send_to_session / read_session / stop_session
                                      ├─ settle_session ──> thread.settle (+ worktree cleanup)
                                      └─ post_report ──> thread.report.post (internal command)
                                             │
             thread.report-posted / terminal session events
                                             │
        SessionSpawnReactor ── thread.turn.start on the spawning thread (the "wake-up")
```

## Pieces

- **Contracts** — `packages/contracts/src/sessionOrchestration.ts` (tool inputs/results, error
  union, spawn caps); `SessionReport`, the `thread.report.post` internal command, the
  `thread.report-posted` event, and `OrchestrationThread.reports` /
  `OrchestrationThreadShell.spawnedByThreadId` live in `orchestration.ts`. All additive: optional
  fields and decoding defaults, so pre-feature clients and payloads keep decoding.
- **Bootstrap service** — `apps/server/src/orchestration/ThreadTurnBootstrap.ts`, the
  create-thread + worktree + setup-script + rollback macro extracted from `ws.ts` so the WS
  dispatch path and the MCP handlers share one implementation.
- **Toolkit** — `apps/server/src/mcp/toolkits/sessions/`. Handlers resolve services once at layer
  build and check the `sessions` capability plus the `enableSessionOrchestration` setting per
  call, so the settings toggle applies to running sessions immediately.
- **Delivery modes** — `send_to_session` defaults to `queue`. Busy children persist FIFO queued
  turn starts in the turn projection and release one at each terminal/ready session boundary;
  idle children start immediately. `interrupt` uses the same queue after requesting the existing
  provider interrupt, so replacement waits for the provider's boundary instead of racing it. A
  bounded fallback cancels the replacement, stops the still-running session, and notifies the
  parent if no boundary arrives. Stopped/error sessions cancel queued messages instead of
  resurrecting the child; restart and periodic recovery only release stale persisted sessions
  after confirming there is no live provider binding.
- **Persistence** — migrations 041 (`projection_threads.spawned_by_thread_id`), 042
  (`projection_thread_reports`), 043 (structured report fields), 044 (session stop audit) and
  045 (`projection_thread_reports.origin`), with hydration through `ProjectionPipeline` and
  `ProjectionSnapshotQuery`.
- **Reactor** — `apps/server/src/orchestration/Layers/SessionSpawnReactor.ts` watches
  `thread.report-posted` and `thread.session-set` domain events. A report on a thread with
  `spawnedByThreadId` starts a turn on the parent carrying the report. Turn injection is the wake
  mechanism deliberately: no held-open tool calls, survives restarts, works over remote/tunnel.

## Terminal reports

A spawned session that dies without calling `post_report` used to leave its parent with nothing:
`stopped` was not even a notification, and an error notification carried no record of what the
child had done. So the reactor synthesizes one. When a child's session reaches `stopped` or
`error` and it has posted no report, the reactor dispatches an ordinary `thread.report.post`
carrying the termination reason, the last tool activity and assistant message, and an explicit
"work is likely unfinished" warning. Everything downstream — projection, the user's report card,
the parent wake-up — then behaves exactly as it does for an agent-posted report.

Two things react to the same terminal `thread.session-set`, and the order is deliberate: the
delivery-mode queue is cancelled first, so the parent learns its pending messages were dropped
before the report explaining where the child stopped arrives. They are otherwise independent —
cancellation is a no-op on an empty queue, and a repeated terminal event re-runs it harmlessly.

`SessionReport.origin` (`"agent" | "system"`) is what keeps the two honest: a synthesized report
must never read as the child's own claim that the work is done, so the parent notification says
Phoenix generated it. Synthesis is once per terminal episode and re-arms when the session comes
back to life; a thread that already has a report is left alone, because the agent's own account
wins. The episode is marked only once the report is actually persisted — a terminated session
emits no further status transition, so marking an episode "handled" on a dispatch that failed
would strand the parent in silence forever. That in-memory set is only an optimization; the
persisted `reports` check is what actually prevents duplicates.

## Settling a child

Sessions do not settle themselves — a finished report is not the same claim as "this thread is
done", and only the parent knows whether it still needs the child. `settle_session` is the
parent's explicit call, and it draws the line at a turn in flight: a `starting`/`running` child is
refused with an actionable message, because interrupting live work stays a deliberate
`stop_session`. An idle-but-alive child (`ready` — the process is sitting there resumable) is a
different case: settling is the parent declaring the child finished, so the session is stopped as
part of it. Order is stop → settle → cleanup, and it matters:

- Stopping first means `ready` children do not leak a provider process behind a settled thread.
- Settling before any filesystem work keeps the reversible half first: a thread that turns out to
  be unsettleable (open approval, queued turn — the decider's own guards still apply) never gets
  its worktree deleted.
- Assessing the worktree _after_ the process is gone closes the window where a racing
  `send_to_session` could start a turn writing into a directory between the dirty check and the
  removal.

If the session does not reach `stopped` within the timeout, the thread is still settled but
cleanup is withheld and the caller is told: deleting files under a process that refused to die is
how a "cleanup" corrupts a live turn.

That stop is deliberately **immediate** — no `gracePeriodMs`, no partial report requested — even
though `stop_session` can stop gracefully. A grace period buys a working agent time to wrap up and
report before the axe falls; settle_session has already refused anything `starting`/`running`, so
by construction there is no work in flight to wind down and nothing the child could report that it
could not have reported already. Waiting one out would only delay the settle and, with
`cleanupWorktree`, hold the worktree hostage. The stop still carries `stopReason: "parent_stopped"`
/ `stoppedBy: "parent"`, so it is not anonymous in the stop audit.

`cleanupWorktree: true` is the only thing in the server that reclaims a spawned worktree; without
it a long orchestration run leaks a directory per child. Deletion is permanent, so it is refused —
with the specific dirty files and unpushed commit count — unless the work is committed and pushed,
or `force: true` is passed. Only `t3code/…` temporary branches are ours to delete; any other branch
is kept and reported. Note that `deleteRef` itself is a dumb primitive: the safety lives in
`decideBranchCleanup` at the call site, not in the driver. The result always names what was removed
and what was kept, and the thread's `worktreePath` is cleared so `read_session` stops advertising a
directory that no longer exists.

## Guardrails

- Mutating tools operate only on direct children of the calling thread.
- At most `SESSION_SPAWN_MAX_CHILDREN` (8) live children per thread and
  `SESSION_SPAWN_MAX_DEPTH` (3) levels of nesting.
- A child's `runtimeMode` is capped at its parent's.
- Spawned threads participate in normal archive/settle session cleanup, so orchestration cannot
  leak provider processes.

## Gotcha worth remembering

Every MCP tool here must declare at least one (optional) parameter. An empty `Schema.Struct({})`
encodes to a typeless `anyOf` JSON schema, and Claude Code drops an MCP server's entire toolset
when any single tool schema fails its validation — while still reporting the server as connected.

## Follow-up: notify delivery

Provider steering is not uniform: some adapters treat a mid-turn send as guidance while others
reject it or start a distinct turn. `send_to_session` therefore exposes only `queue` and
`interrupt` for now. A future `notify` mode needs an explicit provider capability and fallback
contract before it can promise tool-boundary guidance without accidentally starting a turn.

Queued-row cleanup for deleted/archived threads and replacing the global recovery scan with a
thread-indexed query remain persistence follow-ups; terminal session transitions are cleaned up
by this delivery workflow.

The web client currently renders the queued user message but does not surface a queued-delivery
indicator because its reducer intentionally ignores the new event. That affordance is a separate
web-app follow-up; the server contract and delivery behavior do not depend on it.
