# Session Orchestration

An agent session can spawn other sessions and coordinate them. Ask a thread to split work across
providers — "spawn a Codex session to write the tests while you refactor" — and it can create the
sessions, hand each one a task, and collect the results without you shuttling messages between
threads.

## How It Works

Every session has tools for orchestration alongside its other Phoenix tools:

- **List providers** — enumerate the providers and models this environment can start, so the agent
  offers real choices instead of guessing.
- **Spawn a session** — create a new thread on a chosen provider and model with an opening prompt.
  By default the new session gets its own git worktree, so parallel sessions never trample each
  other's files. Spawned threads appear in your sidebar like any other thread, marked with a
  "Spawned by" banner that links back to the thread that created them.
- **Message, read, and stop** — a session can send follow-ups to sessions it spawned, check their
  progress, and stop them. It cannot touch threads it did not spawn.
- **Ping without disturbing** — a session can peek at a spawned session's live progress (status,
  current activity, plan step, whether a report has landed, and a best-effort usage snapshot —
  tokens, turn count, elapsed time) without starting a turn or interrupting it, for a cheap check
  between messages.
- **Post a report** — when a spawned session finishes, it posts a completion report: a status, a
  summary, and any artifacts (files, branches, PR links). The report shows as a card in the thread,
  and the session that spawned it is woken automatically with the result — no polling. The report
  also carries the same usage snapshot, captured at the moment it was posted, so the spawning
  session can see what the work cost.
- **Settle a session** — once the spawning session is done with a child, it marks it settled so the
  thread stops counting as live work. Settling also shuts the child's agent down, so a finished
  session does not sit around holding a process. A child that is mid-task is refused instead: the
  spawning session has to stop it deliberately. Settling can also delete the child's worktree,
  which is the only thing that reclaims those directories.

If a spawned session is stopped or hits a provider error before it reports, Phoenix writes the
report for it: why it ended, what it was last doing, and a warning that the work is probably
unfinished. Those reports are labelled as Phoenix-generated, so you and the spawning session can
always tell them apart from a report the agent actually wrote.

Deleting a worktree is permanent. Phoenix refuses if the worktree still holds uncommitted changes
or commits that exist nowhere else, and tells the session exactly what is at risk; the session has
to insist before anything is lost. Branches Phoenix did not create are never deleted.

## Limits

Orchestration is bounded so a runaway agent cannot overwhelm your machine:

- A session can have at most 8 spawned sessions at a time.
- Spawn chains go at most 3 levels deep.
- A spawned session never gets a more permissive permission mode than the session that spawned it.

## Turning It Off

Settings → General → **Session orchestration** disables the feature for the whole environment. The
switch applies immediately, including to sessions that are already running.
