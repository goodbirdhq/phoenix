# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Phoenix keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, Phoenix hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Phoenix opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

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
