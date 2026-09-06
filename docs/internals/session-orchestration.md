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
  `ping_session` also carries the liveness diagnostics (`stalledDeliveryCount`,
  `oldestUndeliveredMessageAt`, `awaitingParentReplySince`) and, once the session is terminal, a
  typed `exitReason` (`deriveSessionExitReason` in `orchestration.ts` — one precedence order over
  `lastErrorKind`/`stopReason`/`stoppedBy`/`status`, quota first) with `lastError` and the stop
  audit as the raw detail.
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
  `spawnedByThreadId` appends a typed `session-report.posted` activity on the parent, which wakes a
  settled or snoozed parent in the client lifecycle. Web and
  desktop group current activities into a capped digest; mobile receives the same typed activity
  and lifecycle visibility, while its dedicated digest UI is deferred. The activity carries child/report IDs, status, origin,
  and the supersession edge; reports remain the source of truth and are pulled with `read_report`
  or `read_session`. Its command and activity IDs are deterministic from parent/child/report IDs;
  command receipt handling and projector replacement make duplicate processing harmless when it
  occurs. Delivery after a reactor crash before dispatch acknowledgement remains the existing
  event-stream/recovery concern and is intentionally not claimed as a new guarantee here.

  Alongside that activity, the reactor delivers the report to the parent as an ordinary
  `thread.turn.start` — the same path `send_to_session` uses — so the decider applies the usual
  rules: an idle parent starts a turn on it, and a busy parent queues it FIFO behind the turn it is
  already running. The delivered text is `formatReportMessage`, which inlines reports at or under
  `SESSION_REPORT_INLINE_MAX_CHARS` and otherwise sends the compact envelope pointing at
  `read_report`. The delivery command and message IDs are deterministic from parent/child/report
  IDs, so a replay after a crash re-dispatches an already-receipted command rather than delivering
  the same report twice.

  This is a per-child choice, not a global one. `spawn_session` takes `reportDelivery`, stored on
  the child thread (`projection_threads.report_delivery`) and read back at report time. It defaults
  to `queue`; `notify-only` keeps the activity and skips the turn, for a parent that would rather
  poll with `ping_session` than be woken. The cost of the default is explicit: a child that posts
  six reports costs its parent six turns, because each is delivered like a separate human message.
  A parent fanning out to cheap children it does not need to hear from should spawn them
  `notify-only`.

## Child→parent messages

`send_to_parent` is the upward half of the channel: a spawned session delivers text to the thread
that spawned it, framed as coming from a named agent session (never the user, and explicitly
carrying no user authority), through the same `thread.turn.start` path every other message takes —
an idle parent wakes, a busy parent queues it FIFO. The strictly-downward rule on every other
mutating tool stands; this is one narrow upward affordance, refused with `not_a_spawned_session`
for top-level threads and `parent_not_available` when the parent is archived or deleted.

The parent delivery and the child's `session-message.sent` activity are emitted by one durable
`thread.turn.start` command, so neither half can land without the other. The activity is both the
visible timeline record and the event the awaiting-reply signal folds from. The signal itself is a
projector-maintained shell field:
`projection_threads.awaiting_parent_reply_since` (migration 057) is set by the
`thread.activity-appended` case in `ProjectionPipeline` when the marker declares
`awaitingReply: true` (latest marker wins — a later non-awaiting send withdraws the claim) and
cleared by a human message or a message from that child's parent. Unrelated system and descendant
session messages do not masquerade as the awaited reply. One owner, every reader: `ping_session` and
`list_sessions` hand the shell value through, the web sessions panel shows the child as
"Awaiting reply", and the sidebar/mobile thread rows label it "Waiting on parent". The clients
also derive the typed exit reason locally (`deriveSessionExitReason` over the shell's session
audit), so a dead child's row says quota/crash/stop instead of a bare status.

In the chat timeline, all three inter-session verbs get routed rows instead of opaque MCP tool
calls: `deriveSessionMessageToolActivity` (in `@t3tools/shared/toolActivity`, beside the spawn
derivation) recognizes `send_to_session`/`send_to_parent` for both clients, and
`ActivityPayloadProjection` carries the derived identity past result slimming — necessary because
the up direction's target (`parentThreadId`) only exists in the summarized result. Web renders
`SessionMessageCtaRow` (MessagesTimeline); mobile keeps its row idiom (rewritten heading, message
icon, preview) and gains tap-to-open via `ThreadFeedActivity.openThreadId`, which also makes the
existing spawn row navigable.

Attribution is typed end to end: `OrchestrationMessageOrigin` (`kind: "session" | "phoenix"` plus
the related threadId) rides the turn.start command, the message-sent event, and
`projection_thread_messages.origin_json` (migration 058). Every server-side writer declares
itself — send*to_parent/send_to_session, report deliveries (`session`), death/wedge/interrupt and
grace-stop notices (`phoenix`) — while the client command schema has no origin field, so a client
cannot forge agent attribution onto a human message. Clients render origin messages as
left-aligned routed cards ("From session X" / "Phoenix"), never as the human's bubble; the body
stays the exact text the model consumed. The thread detail also now carries `queuedTurnStarts`
(kept live by the client reducer from the queue lifecycle events), which powers per-message
"queued — delivers after the current turn" markers and the inbox's "waiting for the agent"
section, so \_sent* and _heard_ are finally distinguishable in the UI.

The channel-physics contract itself is injected into every child's first message
(`spawnedSessionPreamble` in the toolkit handlers): what wakes whom, that in-thread text reaches
no one, `send_to_parent` vs `post_report`, and that a session can end without warning. Physics
only, deliberately: working-style discipline (commit cadence, how much to trust relayed state) is
left to the agent and the parent's prompt, not dictated by the shell.

## Terminal reports and death notices

A spawned session that dies without calling `post_report` used to leave its parent with nothing:
`stopped` was not even a notification, and an error notification carried no record of what the
child had done. So the reactor synthesizes one. When a child's session reaches `stopped` or
`error` and it has posted no report, the reactor dispatches an ordinary `thread.report.post`
carrying the termination reason (including the typed `exitReason`), the last tool activity and
assistant message, and an explicit "work is likely unfinished" warning. Everything downstream —
projection, the user's report card, and the parent digest — then behaves exactly as it does for
an agent-posted report.

The report is the durable _account of the work_; the **death notice** is the _fact of the death_,
and they deliberately travel differently. On the same terminal transition the reactor sends the
parent a message (`formatDeathNotice`) with the typed exit reason, the provider's error text, a
best-effort git accounting of the worktree (dirty files and unpushed commits, bounded by a 5s
timeout so a slow status can never delay the news; "could not be inspected" is reported rather
than read as clean), and where the durable account lives. Three rules keep it honest:

- The notice ignores `reportDelivery` — `notify-only` opts a parent out of report chatter, not out
  of learning its child died. Silence never means health.
- It fires even when the child had already reported: an existing report says what the work was,
  not that the session later died holding it.
- It is suppressed when the exit reason is `stopped_by_parent` — settle/stop_session must not turn
  into self-notification, and the synthesized report still lands as the durable record.

To keep one death from double-waking the parent, a system-origin `thread.report-posted` is never
delivered as a message: the activity/inbox row is written, and the death notice (which names the
synthesized reportId) is the single wake. Ordering on the terminal event is deliberate: queue
cancellation first (the parent learns its pending messages were dropped), then the synthesized
report, then the notice that points at it.

`SessionReport.origin` (`"agent" | "system"`) is what keeps the accounts honest: a synthesized
report must never read as the child's own claim that the work is done. Synthesis is once per
terminal episode and re-arms when the session comes back to life. `episode_started_at` (migration 059) scopes report lookup and deterministic report/notice identifiers to the current episode, so a
historical report cannot suppress or misdescribe a later crash. Stop audit is cleared when a new
episode starts. The episode is marked only once
the report and notice are actually dispatched — a terminated session emits no further status
transition, so marking an episode "handled" on a dispatch that failed would strand the parent in
silence forever. That in-memory set is only an optimization; deterministic episode-scoped report
and delivery identifiers make retries converge after restart.
At reactor startup, Phoenix scans spawned terminal shells as well as queued-delivery rows and
replays this terminal workflow. That closes the crash window between persisting the terminal
session/report and enqueueing its asynchronous death notice.

## Delivery stall detection

An unconfirmed release is a delivery diagnostic, not proof of a stuck provider. A message in
`releasing` has no recorded adapter acceptance yet; provider startup, an in-flight send, or
receipt persistence can account for the delay. The raw receipt now crosses the wire whole (`releasingAt` and `redeliveryCount` on
`QueuedDeliveryReceipt`), `ping_session` counts stalled releases and dates the oldest unconsumed
message. A stale release with no live binding is retried up to the redelivery limit; a release that
remains stale while its provider binding is still live is cancelled after two minutes rather than
risk sending duplicate provider work. Either cancellation sends one deduplicated notice per child
to the parent — the error activity alone lands on the wedged child's own thread,
where nobody who can act on it is looking. A report posted over unconsumed queued messages also
carries the `formatQueuedReportWarning` line in its delivery, so a parent never mistakes a
pre-instruction report for an answer.

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
or `force: true` is passed. Only `phoenix/…` temporary branches (and legacy `t3code/…` temporary
branches) are ours to delete on sight; any
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
and for **every** branch deletion — temporary `phoenix/…` branches included, since nothing stops a
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

## Child-report inbox reads

Posting a report appends a `session-report.posted` activity to the active parent's thread. The web
inbox is deliberately passive: opening it or navigating to a child emits no command. Consumption
has exactly two writers, and they converge on one receipt:

- the parent's explicit `read_report({ reportId })` for a direct child, and
- **delivery consumption**: when a parent turn starts on a delivered report message (the reactor
  minted its message id as `session-report-delivery:<child>:<reportId>`, so the
  `thread.turn-start-requested` event identifies the report), the reactor appends the same
  `session-report.read` activity. With queue delivery — the default — the agent receives the full
  report as its turn input and has no reason to ever call `read_report`; before this path existed,
  every queue-delivered report sat "unread" forever and the inbox accumulated history instead of
  showing the unacknowledged set.

The automatic writer also verifies the server-only message origin against the persisted report:
agent reports must arrive as the child session, while a synthesized report carried by a death
notice must arrive as Phoenix. In both cases the child must belong to the receiving parent. A
paired client therefore cannot forge a read by choosing the delivery-shaped message id.

Both the activity ID and its command ID are derived from `parentThreadId + reportId`, so the
orchestration command-receipt table makes concurrent calls, the two acknowledgement paths, and
event-stream replay all return the same receipt rather than write a second consumption event. This
keeps consumption event-sourced and avoids materializing the parent's full thread detail just to
check whether an earlier read exists.

Reports and read activities are events, while the thread activity list is an operational inbox
projection. Its retention policy is explicit: retain every currently unread report notification
plus the newest 500 non-report activities; when `read_report({ reportId })` appends its receipt,
evict both that receipt and the matching notification. Thus completed report/read lifecycles have
zero activity-list capacity and cannot grow a busy parent forever. The unavoidable inbox capacity
is the number of reports the parent has not yet read: evicting one of those would silently mark it
read, so it is intentionally not permitted. Full report history (and every receipt) remains in the
event stream and `projection_thread_reports`, so a parent may read a direct child's report by id
even after that child is archived. Archived targets never gain sibling access, and the `threadId`
convenience form remains observational for every target. If that noncritical consumption append is
temporarily unavailable, `read_report` still returns the durable report and a later read retries
the same deterministic command. The UI copy must continue to state that opening the inbox does
not mark anything read.

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

Web and mobile render queued and releasing delivery markers from the same receipt state. Both
resolve routed-session titles from one environment-level title map instead of mounting a live shell
subscription for every historical message.

## Delivery acceptance and interruption

Queued input acceptance is recorded by `ProviderCommandReactor` after `ProviderService.sendTurn`
returns the adapter's turn ID. The internal `thread.turn.queue.consume` command emits the existing
`thread.turn-start-consumed` event with the original message ID. Runtime status transitions and
native background turns do not determine acceptance for new sends. The session marker remains for
historical compatibility; new sends leave it empty. This receipt means adapter acceptance, not
model understanding or completion. Each provider keeps its existing send/acceptance semantics,
including steering into an existing turn.

`QueuedDelivery` serializes delivery admission, cancellation, and recovery per thread. It never
holds that permit during provider I/O or receipt persistence. Cancellation before admission skips
the send; cancellation of an admitted attempt cannot retract input already in flight. An accepted
input retries only its receipt write, with exponential jittered backoff capped at five seconds,
never the provider send. Late acceptance can correct a cancelled receipt; the cancellation event
remains in history. Pending attempts prevent concurrent redelivery of the same message.

Cursor and Grok expose ACP prompt dispatch separately from prompt completion. `ProviderService`
returns acceptance at dispatch while supervising completion in its own scope. A later binding
metadata write failure cannot erase that acceptance. Other adapters retain their native acceptance
semantics. No provider status transition acknowledges a queued message, including legacy markers.

Claude first uses native interruption for foreground work and retains the healthy runtime after
its result boundary. Background work or failed native interruption requires query closure and an
observed owned-process exit before resuming. SDK iterator cleanup alone is insufficient. Intentional
interruption does not publish a terminal exit; explicit stops retain terminal behavior. Interrupt
timeouts escalate plain Stop as well as queued interruptions, guarded by the original turn and
episode. Unconfirmed interruption or process termination never claims the session is ready.
Provider interrupt and stop I/O run outside the global command worker. Terminal queue cancellation
checks the episode inside the decider, so an old notice cannot cancel a resumed episode's work.

Session event workers preserve ordering per thread. New worker lanes evict idle entries once the
cache reaches 256; busy lanes remain until they drain. Activity observations have a separate
fixed-size cache.

`lastActivityAt` merges persisted provider-binding time with a bounded in-memory watermark of
runtime traffic received by Phoenix, scoped to the bound provider instance. Runtime events update
that watermark without SQLite writes or additional websocket broadcasts. Restart or cache eviction
falls back to binding time. This is best-effort activity evidence, not a heartbeat or proof of death.
`stalledDeliveryCount` counts releasing messages without acceptance; use `releasingAt` for delivery
age, because `oldestUndeliveredMessageAt` includes ordinary queue waiting time.
