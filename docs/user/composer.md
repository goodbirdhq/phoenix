# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Phoenix keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Stopping a turn

Stop ends the agent's current turn. It also stops any background work that turn started, such as
subagents or long-running shells, so a runaway fleet cannot keep burning tokens after you have
asked it to halt.

Background work outlives the turn that started it. On web and desktop, Stop therefore stays
available on a thread whose turn has already finished while its agents are still running; the
mobile app can only stop a turn that is still in progress.

With Claude, a stop that cannot reach the agent leaves a note in the thread rather than appearing
to have worked. Other agent CLIs report stop failures less reliably; if a thread keeps working
after you press Stop, it is still running.

If an agent's process disappears entirely, Phoenix ends the turn and marks the thread as failed
rather than leaving it to look busy forever.
