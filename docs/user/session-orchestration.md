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
- **Post a report** — when a spawned session finishes, it posts a completion report: a status, a
  summary, and any artifacts (files, branches, PR links). The report shows as a card in the thread,
  and the session that spawned it is woken automatically with the result — no polling.

If a spawned session hits a provider error instead of finishing, the spawning session is notified
of that too.

## Limits

Orchestration is bounded so a runaway agent cannot overwhelm your machine:

- A session can have at most 8 spawned sessions at a time.
- Spawn chains go at most 3 levels deep.
- A spawned session never gets a more permissive permission mode than the session that spawned it.

## Turning It Off

Settings → General → **Session orchestration** disables the feature for the whole environment. The
switch applies immediately, including to sessions that are already running.
