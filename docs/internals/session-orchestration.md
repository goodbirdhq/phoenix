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
                                      ├─ send_to_session / read_session / ping_session / stop_session
                                      ├─ settle_session ──> thread.settle (+ worktree cleanup)
                                      ├─ read_report ──> projection_thread_reports (paginated body)
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
  call, so the settings toggle applies to running sessions immediately. `ping_session` (and the
  `lastActivityAt`/`currentActivity` fields on `read_session`) is pull-based, read-only visibility
  into a child's progress — `ThreadBackgroundLiveness`, `ThreadPlanProgress`, and the provider
  session directory's `lastSeenAt` — without starting a turn or otherwise touching the child.
- **Delivery modes** — `send_to_session` defaults to `queue`. Busy children persist FIFO queued
  turn starts in the turn projection and release one at each terminal/ready session boundary;
  idle children start immediately. `interrupt` uses the same queue after requesting the existing
  provider interrupt, so replacement waits for the provider's boundary instead of racing it. A
  bounded fallback cancels the replacement, stops the still-running session, and notifies the
  parent if no boundary arrives. Stopped/error sessions cancel queued messages instead of
  resurrecting the child; restart and periodic recovery only release stale persisted sessions
  after confirming there is no live provider binding.
- **Persistence** — migrations 041 (`projection_threads.spawned_by_thread_id`), 042
  (`projection_thread_reports`), 043 (structured report fields), 044 (session stop audit), 045
  (`projection_thread_reports.origin`), 046 (`projection_thread_reports.abstract`), and 048
  (`projection_thread_reports.supersedes_report_id`), with hydration through `ProjectionPipeline`
  and `ProjectionSnapshotQuery`.
- **Reactor** — `apps/server/src/orchestration/Layers/SessionSpawnReactor.ts` watches
  `thread.report-posted` and `thread.session-set` domain events. A report on a thread with
  `spawnedByThreadId` starts a turn on the parent carrying the report. Turn injection is the wake
  mechanism deliberately: no held-open tool calls, survives restarts, works over remote/tunnel.
  Reports over `SESSION_REPORT_INLINE_MAX_CHARS` (1KB) — agent-posted and Phoenix-synthesized
  alike — are delivered as a compact envelope (title, status, origin, abstract, reportId, size,
  structured counts) instead of inline; the parent — or a sibling — pulls the full body and the
  full findings/validation arrays on demand with `read_report`, paginated by `offset`/`maxChars`
  in UTF-16 code units.

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

## Usage snapshot

`ping_session` and every posted report (agent or synthesized) carry an optional `usage` snapshot —
`lastTurnInputTokens`, `lastTurnOutputTokens`, `totalTokens`, `turnCount`, `elapsedMs` since spawn,
and `lastTurnDurationMs` — so an orchestrating parent can budget instead of flying blind.
`apps/server/src/orchestration/sessionUsage.ts` builds it from data that already exists rather than
adding new provider plumbing: the latest `context-window.updated` activity (the same
`projection_thread_activities` rows the web client's context-window meter reads, populated by
`ProviderRuntimeIngestion` from the provider adapters' `thread.token-usage.updated` events) plus two
bounded queries — `getLatestUsageActivity` (one row) and `getThreadTurnCount` (one indexed
aggregate, filtered to `turn_id IS NOT NULL` so pending placeholders and queued/interrupting rows
never inflate the count). Both degrade to "field omitted" on failure, the same contract as
`ping_session`'s other purpose-built reads (`getThreadHasReport`, `getLastAssistantMessage`):
optional enrichment must never fail the caller. Token fields are omitted, not zero, when a provider
does not report them.

The token field names are literal about their scope, because the two provider adapters only report
per-turn usage at the message level: `lastTurnInputTokens`/`lastTurnOutputTokens` are the most
recent turn's counts, not a session accumulation — and not comparable across providers, since
Claude's input count folds in cache-read/cache-creation tokens that Codex reports separately.
`totalTokens` is sourced only from a provider's own cumulative counter
(`ThreadTokenUsageSnapshot.totalProcessedTokens`) and omitted, never backfilled from context-window
occupancy (`usedTokens`), which is bounded by the window and drops after compaction — the opposite
of a monotonic spend number.

For a report, `usage` is captured server-side at `post_report` (or terminal-report synthesis) time —
never agent-supplied — and persisted in the same `structured_json` blob as findings/validation/
recommendation/completionPercent (`SessionReportStructuredFields`), so no migration was needed. It
rides along automatically to `SessionReportEnvelope` and `read_report`.

Deliberately no cost estimate anywhere in this: provider price tables go stale, so tokens are the
stable currency and converting to cost, if a caller wants that, is a client-side concern.

## Amending a report

A report is a claim about work, and a queued instruction can arrive after the child already made
it. Left alone, the stale report stays the record — and the incident that motivated this was worse
than stale: the child, having reported, then claimed compliance with an instruction it had never
acted on. So `post_report` takes an optional `supersedesReportId`, and the amendment — not the
original — becomes the session's current account.

Nothing is rewritten. The projection is append-only: the amendment stores a forward link
(`supersedes_report_id`), the superseded report keeps its own row, its own event, and its own body,
and the reverse link (`supersededByReportId`) is _derived_ on every read path by asking which later
report points back at this one. That is why there is no "superseded" flag column to keep in sync,
and why a report can be read from either end of the chain.

Chains are **linear, never forked**: superseding a report that is already superseded is refused.
Two reports both amending A would leave "which is current" ambiguous — reverse navigation from A
could reach either, while latest-report selection picks by recency, and the two answers need not
agree. Rather than teach every reader a merge rule, the loser is refused and handed the head of the
chain (`SessionOrchestrationReportAlreadySupersededError` carries `supersededByReportId` and
`chainHeadReportId`, because the caller's next move is mechanical: re-post against the head).

The **decider** is where that check is authoritative, not the toolkit. Handler-level validation
alone cannot prevent a fork: two amendments of the same report can both pass their pre-checks
before either is dispatched. The decider runs against the folded read model _serialized with
command processing_, so the second one loses deterministically — and it also covers
`thread.report.post` commands dispatched internally, which never pass through the toolkit at all.
The toolkit keeps a pre-check purely for error quality: the common case fails with a structured
error instead of a dispatch failure, and a caller that loses the race gets that same structured
error because post_report re-reads the chain before surfacing the rejection. Both sides share one
implementation (`checkReportSupersession`) and one wording, so they cannot disagree.

The reference must also name a report on the _calling thread_. A report is a session's account of
its own work, so amending another session's report is not a weaker case of amending your own — it
is refused, with the same message as an unknown id so the denial cannot double as a probe for which
report ids exist elsewhere. A dangling link would be worse than a rejection: no reader could follow
it.

A Phoenix-synthesized terminal report is amendable like any other, which is what makes resurrection
work: a session that was stopped, had a report synthesized for it, then resumed and finished can
supersede the stand-in with its own account. The superseded row keeps `origin: "system"`, so the
history still shows that Phoenix stood in.

Both ends travel outward. Envelopes and `read_session` carry `supersedesReportId` /
`supersededByReportId`; the parent notification for an amending report leads with
`AMENDED report (supersedes …)` before the summary, because a parent that already acted on the
superseded report has to see that first. `read_report` on a superseded report returns the body it
always did — the record is append-only — plus `supersededByReportId` and a `supersededNotice`
sentence: a caller paging an old report must learn a newer one exists, and cannot be relied on to
notice a field it was not looking for.

`SPAWNED_SESSION_REPORT_INSTRUCTIONS` (force-appended to every spawned prompt) tells children the
rule directly: an instruction arriving after you reported means post an amending report — never
claim retroactive compliance.

The event payload change follows the event-sourcing rule: `supersedesReportId` is optional on both
the `thread.report.post` command and the `thread.report-posted` payload, so every already-persisted
report event replays unchanged. `supersededByReportId` is deliberately _not_ in the payload — at
post time no such report exists yet, and inventing one would make the event a lie.

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

- Mutating tools operate only on direct children of the calling thread. The read-only
  `read_report` additionally allows reading reports of sibling threads (same
  `spawned_by_thread_id`), which is the minimal primitive for peer workflows — e.g. a reviewer
  child reading a worker child's report without the parent relaying it.
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
