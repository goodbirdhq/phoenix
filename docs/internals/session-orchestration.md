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
                                      ├─ list_sessions / send_to_session / read_session /
                                      │     ping_session / stop_session
                                      ├─ settle_session ──> thread.settle (+ worktree cleanup)
                                      ├─ archive_session ──> settle cascade (if unsettled) +
                                      │     thread.archive (+ worktree cleanup, default on)
                                      ├─ read_report ──> projection_thread_reports (paginated body)
                                      └─ post_report ──> thread.report.post (internal command)
                                             │
             thread.report-posted / terminal session events
                                             │
        SessionSpawnReactor ── thread.activity.append on the spawning thread (report digest)
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
  `spawnedByThreadId` appends a typed `session-report.posted` activity on the parent; it wakes a
  settled or snoozed parent in the client lifecycle but never requests a provider turn. Web and
  desktop group current activities into a capped digest; mobile receives the same typed activity
  and lifecycle visibility, while its dedicated digest UI is deferred. The activity carries child/report IDs, status, origin,
  and the supersession edge; reports remain the source of truth and are pulled with `read_report`
  or `read_session`. Its command and activity IDs are deterministic from parent/child/report IDs;
  command receipt handling and projector replacement make duplicate processing harmless when it
  occurs. Delivery after a reactor crash before dispatch acknowledgement remains the existing
  event-stream/recovery concern and is intentionally not claimed as a new guarantee here.

  On upgrade, the queued-turn release path recognizes the exact legacy Phoenix report envelope and
  cancels that row with `legacy_report_notification`; ordinary queued user messages are never
  inferred from report-like text and retain their existing delivery behavior.

  There is deliberately no report-to-turn delivery mode. Compatibility is explicit: an agent that
  wants the parent to act sends an ordinary, meaningful `send_to_session` instruction referring to
  a report ID, retaining that tool's existing queue/receipt semantics. A report itself never adds
  queued turn work, so a burst cannot create unbounded parent work. A future, separate API may add
  a bounded report-escalation request with a parent-selected cap/coalescing policy; it must not
  reuse report posting as implicit escalation.

## Terminal reports

A spawned session that dies without calling `post_report` used to leave its parent with nothing:
`stopped` was not even a notification, and an error notification carried no record of what the
child had done. So the reactor synthesizes one. When a child's session reaches `stopped` or
`error` and it has posted no report, the reactor dispatches an ordinary `thread.report.post`
carrying the termination reason, the last tool activity and assistant message, and an explicit
"work is likely unfinished" warning. Everything downstream — projection, the user's report card,
and the parent digest — then behaves exactly as it does for an agent-posted report.

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
`supersededByReportId`; the parent digest labels an amending report with its
`supersedesReportId`, because a parent that already acted on the superseded report has to see that
edge first. `read_report` on a superseded report returns the body it
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
how a "cleanup" corrupts a live turn. A plain settle (no `cleanupWorktree`) has nothing to withhold,
so it succeeds — but it now carries a `warning` naming the provider and the status the session was
last seen in. A settle that quietly leaves a live process behind is how orphans accumulate
unnoticed.

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
or `force: true` is passed. Only `t3code/…` temporary branches are ours to delete on sight; any
other branch is kept and reported unless `cleanupBranch: true` comes with a merge proof (below).
Note that `deleteRef` itself is a dumb primitive: the safety lives in `decideBranchCleanup` at the
call site, not in the driver. The result always names what was removed, what was kept, and the
proof used, and the thread's `worktreePath` is cleared so `read_session` stops advertising a
directory that no longer exists.

## Git hygiene during cleanup

Three failures showed up the first time eight children were settled at once, and all three are
about git being a single-writer program that Phoenix was treating as a service.

**One cleanup per repository at a time.** Git's worktree and ref mutations take locks under `.git`;
concurrent cleanups on one repository do not queue, they sit on the lock until Phoenix's own 15s
command timeout kills them, so seven cleanups failed and the one that ran alone succeeded.
`GitRepositoryLock` (`apps/server/src/git/GitRepositoryLock.ts`) is one Effect `Semaphore` per
repository, and the removal _and_ the branch delete run inside it — the ref delete takes a lock in
the same repository, so leaving it outside would just move the race. The lock is built once, where
the sessions toolkit is registered in `McpHttpServer`, because a per-call instance serializes
nothing. Reads (`status`, `rev-parse`) stay outside: they do not take the lock.

The key is what makes it a mutex rather than a decoration. Keying on the path as handed in gives
`/tmp/repo`, its symlink `/link/repo`, and a linked worktree of the same repository three different
semaphores — serializing nothing while looking like it does. So the key is canonical: `realPath`
first, then the repository's common git directory (a linked worktree's `.git` is a file pointing at
`…/.git/worktrees/<name>`, and everything above `worktrees/` is what every worktree shares). Each
step degrades to the best answer so far: a lock keyed on a slightly coarser path is still correct,
while failing to lock is not.

**A leftover lock is reported, never removed.** A git process killed mid-write leaves its lock file
behind and every later git command on that repository fails against it. Reaching that diagnosis
needs what git actually said, and `GitCommandError.detail` is a fixed per-call-site string
("git worktree remove failed"), so the driver attaches a bounded `stderrExcerpt` — the tail, since
git prints progress before the fatal line — to every non-zero exit. Without it the lock path never
leaves the driver and the structured error below can only ever fire in a test. The excerpt is
redacted before it is attached, and redacted before it is truncated so nothing survives on a
boundary: git echoes remote URLs freely and a remote can carry its own credentials
(`https://x-access-token:ghs_…@host/o/r`), so userinfo, query strings, fragments, and known token
shapes are stripped while scheme, host, and path — the diagnostic value — stay. Credentialed URLs
do reach argv (clone, fetch, and push take the remote as an argument), which is why redaction is
written against URL shapes rather than a list of "safe" commands; argv itself is never attached to
an error, only `argumentCount`. Bare secrets still belong on `stdin`, which `execute` takes for
exactly that. The excerpt is
matched on the lock artifact (a `.lock` path) rather than on git's English, which varies by
version, command, and locale. When a git failure names a lock path, `settle_session` stats it and
answers with `SessionOrchestrationGitLockError`: the path,
its age, whether it matches the stale heuristic, and the remedy. The heuristic is deliberately
conservative — zero bytes (git writes the new index into the lock, so an empty one means the writer
died before writing) _and_ older than 60s (longer than any command Phoenix could still have
running). Even when both hold, Phoenix does not delete it: nothing in this process can prove that
no other git — a developer's shell, a second Phoenix, an editor — owns that lock, and deleting a
live one corrupts the index. Naming the file is the whole value; the caller can confirm what this
process cannot.

**Deleting a user's branch needs proof, and `git branch --merged` is not it.** This repository
squash-merges, so a merged branch never becomes an ancestor of `main` and `--merged` reports
nothing — trusting it would refuse every merged branch, and on a rebase-merging repository it would
accept branches that were never merged. `cleanupBranch: true` instead demands commit identity: the
local head, the remote-tracking head, and the head commit of a _merged_ pull request must all be
the same commit (which also means zero commits ahead). Anything else is
`SessionOrchestrationBranchNotMergedError` with the reason and the SHAs that disagree. The proof
runs _before_ the worktree is touched, so a refusal costs nothing and leaves the caller a whole job
rather than half of one. The remote-tracking ref is read as last fetched rather than re-fetched: a
stale ref can only cause a false refusal, never a wrong deletion, because a local branch that
equals a merged PR head holds nothing that is not already published. `ChangeRequest.headRefOid` is
what carries the merged commit; it is optional on the contract, and only the GitHub provider's
non-open listing asks `gh` for it today.

The proof is taken outside the repository lock — it makes a network call, and holding a repository
hostage across one would defeat the point — which leaves a window: a branch can gain commits while
its cleanup waits behind seven others, and a proof from minutes ago would authorize deleting them.
So the cheap half is re-read inside the critical section, immediately before the delete: two
`rev-parse`s confirming both heads are still the commit the pull request vouched for. A branch that
moved is kept and reported, not deleted — the same outcome as never passing `cleanupBranch`, since
the worktree removal was authorized by the dirty check rather than by this proof.

That re-check is only atomic against writers inside this process, and the repository lock does not
bind a terminal, an editor, or a second Phoenix. There are two races left, and they are not equally
survivable — which is what decides the deletion mechanism.

A **checkout** by another worktree is unrecoverable if we get it wrong: the other worktree's HEAD
ends up pointing at a ref that no longer exists, and no reflog fixes someone else's broken
directory. A **ref move** costs a ref pointer, which the reflog still holds.

Compare-and-swap deletion (`git update-ref -d <ref> <sha>`) closes the second and is _blind_ to the
first: checking a branch out does not move its OID, so the swap succeeds while a worktree holds the
branch. Porcelain deletion (`git branch -D`) is the reverse: it refuses a checked-out branch
atomically at delete time, and cannot notice a concurrent ref move. Phoenix takes `git branch -D`,
because worktree safety is absolute and ref-pointer safety is best-effort-plus-reflog. The in-lock
re-proof stays as the merged-safety check, with the residual stated where the code makes it:
between that check and the delete, an external ref move can lose a pointer.

The explicit `git worktree list --porcelain` check still runs first, inside the critical section
and for **every** branch deletion — temporary `t3code/…` branches included, since nothing stops a
user checking one out. git would refuse anyway; the check exists so the caller gets a structured
refusal naming the conflicting directory instead of a raw git error. An unreadable worktree list
fails closed for the same reason the check exists at all. When a worktree appears in the gap
between the check and the delete, git's own refusal is parsed back into the same structured answer.

Both refusals are structured per resource rather than folded into prose: a settle that removed the
worktree but kept the branch reports `worktree.branchRefusal` (branch, reason, the SHAs, and the
commit the proof expected), sharing its reason vocabulary with
`SessionOrchestrationBranchNotMergedError`. Partial success is still a result the caller has to act
on, and "the branch moved, settle again" has to be distinguishable from "this repository has no
pull-request host" without reading English. A branch delete
that fails on a repository lock surfaces as the same `SessionOrchestrationGitLockError` a failed
removal does, and the thread's `worktreePath` is still cleared first: the directory really is gone,
and failing before recording that would leave the thread pointing at it forever.

## The spawn cap counts active work, not history

`SESSION_SPAWN_MAX_CHILDREN` counts only _active_ children: non-deleted, non-archived, and
**unsettled OR with a live provider binding**, computed by one shared predicate,
`countsTowardActiveCap`, used by both `spawn_session`'s cap check and `list_sessions`'s
`state: "active"` filter — they cannot drift, because a caller who just hit `spawn_limit_reached`
must be able to list exactly the children responsible for it. The "or has a live binding" half
matters because `settleChildCascade` writes `settledAt` unconditionally — a failed stop (the
provider process did not reach `stopped` within the timeout) only withholds destructive worktree
cleanup, not the settle itself (see below). Without this, a wedged provider process could be
"settled" and immediately stop counting while its process is still running, letting a parent spawn
past what should be a hard ceiling on live processes. A settled child only actually frees its slot
once its binding is confirmed gone (the reaper, or a retried `settle_session`/`stop_session`).
`list_sessions`'s `state: "settled"` is the exact complement of `"active"` — settled AND no live
binding, the pool safe to reclaim or discard at leisure — not just "has a `settledAt`"; `"all"` is
both.

**`session.status` is a hint, not proof, of whether a provider binding is still live.**
`isSessionAlive(status)` looks authoritative but isn't: Codex/OpenCode retain an errored session's
binding, and `ProviderCommandReactor` treats any status other than `"stopped"` as
reusable/restartable (see its `existingSessionThreadId` branch) — so an `"error"` status child can
still have a live, restartable process. Cap-counting and cleanup use `resolveHasLiveBinding`
instead — a query against the provider session directory (the same source the recovery sweep uses)
— as the authoritative signal at every decision point: `countsTowardActiveCap`, and
`stopChildSession`'s decision to attempt a stop at all (and what it waits on to confirm the stop
actually happened). Getting this wrong in either direction breaks something — trusting `"error"`
as dead lets a still-restartable child both squat forever if miscounted as alive by a _different_
heuristic, or get archived (worktree deleted) out from under a process that comes back. Status
still shows up in results (`sessionStatus` on `list_sessions` entries) as a legible, cheap-to-read
hint for humans and callers deciding what to do next; it just never gates a decision on its own.

This makes `settle_session` the normal way to free a slot once the process is actually gone: the
parent declares a child finished, its process is stopped, and the slot becomes available again — no
separate archiving step. `archive_session` is not the slot-freeing mechanism; a settled-and-dead
child already isn't counted. What `archive_session` is for: permanently discarding a child
(declutter the board) and reclaiming its worktree/branch (the settle path only reclaims the
worktree if `cleanupWorktree: true` is passed, and leaves the thread itself resumable). A settled
child stays reachable via `send_to_session` as long as its worktree survives; a settled child whose
worktree was already cleaned up cannot be resumed (the platform does not support resuming a session
whose worktree is gone — an existing, unrelated bug), so `list_sessions`'s `worktreePath` field is
the caller's signal for whether `send_to_session` can still bring a settled child back, or whether
`archive_session` is the only option left. That signal is verified with a best-effort filesystem
existence check rather than trusting the cached projection value outright — the projection can go
stale (manual deletion, a partially-failed cleanup) faster than it is reprojected, and a false
"reclaimable" signal is worse than a slightly stale-but-safe one; a failed check degrades to the
cached value rather than hiding it.

Settled-but-undead children are still bounded overall: `SESSION_SPAWN_MAX_RETAINED_CHILDREN` (32)
caps the total non-deleted, non-archived children — active plus settled — one thread may retain, so
a parent that spawns and settles repeatedly without ever archiving cannot accumulate unbounded
thread rows and worktrees. This is a separate, independent ceiling from the active cap; hitting it
fails with its own `spawn_retention_limit_reached` reason and points at `archive_session` to
reclaim capacity.

## Archiving a child

Archiving deliberately **subsumes** settling rather than requiring it as a separate step first: a
child the caller wants gone for good is a child the caller is also done with. An unsettled child
runs the exact same stop → settle → cleanup cascade `settle_session` does — including the same
refusal for a `starting`/`running` child — implemented as one shared helper so the two tools cannot
drift on ordering. An already-settled child skips the redundant `thread.settle` re-dispatch, but
**not** the binding check: `settledAt` is no more proof the binding is gone than `session.status`
is (same reasoning as `countsTowardActiveCap`), so this path still calls `stopChildSession` —
which itself already short-circuits to an immediate no-dispatch `true` when there is nothing to
stop, so a genuinely dead child costs nothing extra. The busy check still applies first (in
principle a settled child's session could come back alive and start a new turn before
`archive_session` catches up).

Unlike the unsettled cascade, an unconfirmed stop on the already-settled path never fails the whole
call: there is no freshly-written `settledAt` here that would otherwise be stranded behind an error
(`settleChildCascade`'s reasoning for failing outright does not apply), so archiving still proceeds
— only the destructive worktree cleanup is conservatively withheld, with the result explaining why.
This is also what makes an unreadable binding directory fail safe end-to-end: `resolveHasLiveBinding`
degrading to "assume bound" makes `stopChildSession` dispatch a stop it can never confirm cleared,
which then simply withholds cleanup here rather than blocking the archive itself.

`cleanupWorktree` defaults to `true` for `archive_session`, the opposite of `settle_session`'s
default. Once a thread is archived it no longer resolves through `requireSpawnedChild` (`getShell`
filters archived threads, same as active-only reads elsewhere), so archiving is the last point
anything in this toolkit can reach the worktree — leaving it around by default would leak it
permanently, since nothing else ever revisits an archived thread. The dirty/unpushed-work refusal
is identical to `settle_session`'s; pass `cleanupWorktree: false` to keep the directory anyway, or
`force: true` to delete over uncommitted or unpushed work.

The result always reports the full cascade — whether a binding was stopped (`null` only for the
already-archived retry no-op below, where nothing runs at all), whether a settle ran (`false` for
an already-settled child, since only its binding gets checked, not re-settled), the worktree
outcome, and that the thread is archived — so a caller never has to infer what happened from a bare
acknowledgement.

`archive_session` is genuinely idempotent, matching its `Tool.Idempotent` annotation: retrying it
against a child that is already archived is a no-op success, not a "not found" error. That needs a
dedicated lookup — `requireSpawnedChild` (via `getShell`) only ever resolves non-archived threads,
so without it a retry (the caller not knowing whether its first call landed, a client-side timeout,
at-least-once delivery) would fail as if the thread never existed. The fallback only runs when the
normal lookup misses, checks the archived snapshot for a thread this caller spawned, and performs no
further mutation on that path — the destructive step already happened (or was already decided
against) the first time.

`list_sessions` bounds `"settled"`/`"all"` queries to `LIST_SESSIONS_MAX_ENTRIES` (50) entries,
most-recently-created first, with `hasMore` signalling truncation. `"active"` is not paginated — it
is already bounded by the spawn cap in steady state. This keeps the per-entry enrichment
(`hasReport`, the worktree existence check) bounded to the page actually returned rather than every
matching child, which matters once retention is only capped at 32 instead of 8.

## Guardrails

- Mutating tools operate only on direct children of the calling thread. The read-only
  `read_report` additionally allows reading reports of sibling threads (same
  `spawned_by_thread_id`), which is the minimal primitive for peer workflows — e.g. a reviewer
  child reading a worker child's report without the parent relaying it.
- At most `SESSION_SPAWN_MAX_CHILDREN` (8) active (unsettled, or settled but still alive) children
  per thread, `SESSION_SPAWN_MAX_RETAINED_CHILDREN` (32) total non-archived children (active +
  settled) per thread, and `SESSION_SPAWN_MAX_DEPTH` (3) levels of nesting.
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

Queued delivery rows are retained after consumption/cancellation as receipts so a parent can
compare an instruction's consuming turn with a report's turn. There is intentionally no retention
cleanup in this slice: deleted/archived-thread cleanup and a bounded receipt-retention policy are
the next persistence follow-up. The global recovery scan should also become thread-indexed;
terminal session transitions are handled by this delivery workflow.

The web client currently renders the queued user message but does not surface a queued-delivery
indicator because its reducer intentionally ignores the new event. That affordance is a separate
web-app follow-up; the server contract and delivery behavior do not depend on it.
