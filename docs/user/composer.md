# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Phoenix keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Stopping a turn

Stop ends the agent's current turn. It also stops any background work that turn started, such as
subagents or long-running shells, so a runaway fleet cannot keep burning tokens after you have
asked it to halt.

If Stop cannot reach the agent, the thread says so rather than appearing to have worked. A stop
that fails leaves a note in the thread instead of a button that quietly does nothing.

## When an agent goes quiet

Occasionally an agent stops reporting while its turn still looks active. After a long silence,
Phoenix adds a note to the thread saying how long it has been since the agent last reported.

The note does not mean the work has failed. Phoenix cannot tell a stuck agent apart from one part
way through a slow step, such as a long build or test run, so it tells you what it knows instead of
guessing. Phoenix never ends the turn on its own — if the work is no longer progressing, use Stop.
