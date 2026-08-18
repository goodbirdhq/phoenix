# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Phoenix keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Stopping a turn

Stop ends the agent's current turn. It also stops any background work that turn started, such as
subagents or long-running shells, so a runaway fleet cannot keep burning tokens after you have
asked it to halt. Background work outlives the turn that started it, so Stop stays available on a
thread whose turn has already finished while its agents are still running.

With Claude, a stop that cannot reach the agent leaves a note in the thread rather than appearing
to have worked. Other agent CLIs report stop failures less reliably; if a thread keeps working
after you press Stop, it is still running.

## When an agent goes quiet

Occasionally an agent stops reporting while its turn still looks active. When that happens, the
thread's status shows how long it has been since the agent last reported — "Quiet 32m" in place of
the usual working time — and stops animating.

This is a statement about silence, not a verdict. Phoenix cannot tell a stuck agent apart from one
part way through a slow step such as a long build, so it shows you what it knows and leaves the
judgement to you. The status returns to normal by itself the moment the agent reports again.

If an agent's process disappears entirely, Phoenix ends the turn and marks the thread as failed
rather than leaving it to look busy forever.
