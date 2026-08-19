# Thread migration across provider instances

Threads can migrate between provider instances — including across drivers — in place, at any
point between turns. Migration records an orchestration event, rebinds the thread's provider
session, and seeds the new provider with the thread's history. The thread keeps its identity:
no forks, no linked-thread entities, no sidebar churn. The flagship trigger is a Claude
subscription hitting its usage window, but the capability is general.

## Why in place, not fork

Phoenix threads are conversations attached to a working directory with checkpoints. Two live
forks of a thread would share one filesystem — that is the parallel-worktree problem, out of
scope here. A frozen-origin "chain" fork was considered and rejected: once the UI collapses
the chain, auto-follows clients, and redirects links, the fork is invisible to the user and
the pointer/redirect machinery buys nothing observable. The instance lock is a runtime guard
in `ProviderCommandReactor`, not a deep invariant of the event model; sessions already carry
their own `providerInstanceId`, so migration is the shallower change. True visible branching,
if it ever ships, arrives as its own feature with its own worktree story.

## Seeding

Every migration starts a fresh provider session. History comes from Phoenix's own event store
(`orchestration_events` / `projection_thread_messages`), never from provider-native session
files, which are instance-scoped and non-portable. Two seeding tiers:

- **Native**: providers that accept start-from-history (Codex `thread/start` by history) get
  the reconstructed transcript directly.
- **Framed prompt**: all other providers (Claude, Cursor, Grok, OpenCode) receive the
  transcript framed into the new session's first prompt.

All five drivers are valid migration sources and targets. Grok's no-model-change-mid-thread
rule does not apply: migration starts a new session by definition.

Two handoff modes:

- **Replay**: Phoenix reconstructs the transcript mechanically. Works even when the origin
  account is out of credit. Always used by auto-failover.
- **Brief**: the origin agent compacts the thread into a handoff document (one origin turn),
  then the target starts from the brief. Higher fidelity, but requires a live origin account;
  the option is disabled when the origin is limited.

Manual migration lets the user choose the mode. Migration is disabled while a turn is
streaming; it runs between turns or from a failed turn.

## Entry points

- **Model picker**: instances on other accounts and drivers are no longer greyed out on
  started threads. Picking a model on a different instance forces the migrate flow.
- **Limit popup**: when an ungrouped account hits its usage window, a component pops up in
  the affected chat: switch-and-retry (primary), switch only (secondary), and a bulk action
  to switch all of that account's active threads.
- **Proactive warning**: chat surfaces a warning near the usage threshold (default 90%) with
  a "hand off now while you have credit" action that runs a brief-mode migration.

All three exist on web, desktop, and mobile.

## Failover groups

A group is an auto-failover set — nothing else. Groups contain instances of one driver only;
cross-driver migration is always a deliberate manual act. When a grouped instance emits a
limit signal, Phoenix migrates the thread to the group member with the most remaining quota
(per-instance availability probe data), replay mode, retries the failed turn, and notifies in
chat. Threads are sticky after the origin's window resets: no auto-return, ever. The way back
is the model picker.

Accounts a user must not mix (work vs personal) simply stay ungrouped: they still get the
limit popup and manual migration, never automatic movement.

## Limit signal

Auto-failover and the limit popup fire only on a classified usage-limit signal, never on
generic turn failures, auth errors, or crashes — those keep the plain error banner. The
primary source is the provider's own native signal: Claude's SDK emits a `rate_limit_event`
that was previously discarded as telemetry, backed by classifying the limit-shaped turn
failure. Codex reports quota through its existing usage surface.

## Out of scope

Parallel/tree forking, cross-driver groups, auto-return after window reset, per-group
priority ordering, and pooled/opaque account rotation are deliberately excluded.
