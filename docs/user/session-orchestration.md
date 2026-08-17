# Session Orchestration

An agent session can spawn other sessions and coordinate them. Ask a thread to split work across
providers — "spawn a Codex session to write the tests while you refactor" — and it can create the
sessions, hand each one a task, and collect the results without you shuttling messages between
threads.

## How It Works

Every session has tools for orchestration alongside its other Phoenix tools:

- **List providers** — enumerate the providers and models this environment can start, so the agent
  offers real choices instead of guessing.
- **List spawned sessions** — see this session's children: status, settled/archived state, whether
  it has posted a report, its worktree, provider/model, and when it was created. Shows active
  (still-counted) children by default — including a settled child whose process has not actually
  stopped yet; ask for settled to see the ones safely done (settled and confirmed stopped), or all
  for both. Archived children are omitted unless asked for.
- **Spawn a session** — create a new thread on a chosen provider and model with an opening prompt.
  By default the new session gets its own git worktree, so parallel sessions never trample each
  other's files. Spawned threads appear in your sidebar like any other thread, marked with a
  "Spawned by" banner that links back to the thread that created them. To see the shape of the
  work at a glance, turn on **Sidebar session hierarchy** in Settings and spawned threads nest
  under the session that started them — see [Organizing threads](./thread-sidebar.md).
- **Message, read, and stop** — a session can send follow-ups to sessions it spawned, check their
  progress, and stop them. It cannot touch threads it did not spawn.
- **Ping without disturbing** — a session can peek at a spawned session's live progress (status,
  current activity, plan step, whether a report has landed, and a best-effort usage snapshot —
  tokens, turn count, elapsed time) without starting a turn or interrupting it, for a cheap check
  between messages.
- **Post a report** — when a spawned session finishes, it posts a completion report: a status, a
  summary, and any artifacts (files, branches, PR links). The report shows as a card in the thread,
  and creates a visible report update in the spawning thread — no polling and no surprise agent
  turn. Several child reports are grouped together there; the parent can read the current report
  or session when it is ready to act. The report also carries the same usage snapshot, captured at
  the moment it was posted, so the spawning session can see what the work cost.

  Opening the report inbox or a child thread does not mark a report as read. An update clears only
  when the parent agent reads that exact report. Both the report and that read activity stay in the
  session history. The parent can still read a direct child's report after the child is archived;
  archived sibling reports are not available through this shortcut.

- **Settle a session** — once the spawning session is done with a child, it marks it settled so the
  thread stops counting as live work — this is also what frees the spawn slot, once the child's
  process has actually stopped (a settle that could not stop the process in time keeps counting
  until it dies). Settling also shuts the child's agent down, so a finished session does not sit
  around holding a process. A child that is mid-task is refused instead: the spawning session has to
  stop it deliberately. A settled child keeps its worktree by default and stays resumable; pass
  cleanupWorktree to reclaim it early.
- **Archive a session** — permanently discards a child: removes it from view and, by default,
  deletes its worktree/branch too. Archiving includes everything settling does: an unsettled child
  is stopped and settled first (refused, the same way, if it is mid-task), then its worktree is
  deleted by default, since an archived thread has no later handle to clean one up. A child that is
  already settled is archived directly. Once archived, a child cannot be resumed — settle it (and
  leave it be) instead if you just want it out of the way for now. Archiving an already-archived
  child is a no-op, not an error, so retrying is always safe.

If a spawned session is stopped or hits a provider error before it reports, Phoenix writes the
report for it: why it ended, what it was last doing, and a warning that the work is probably
unfinished. Those reports are labelled as Phoenix-generated, so you and the spawning session can
always tell them apart from a report the agent actually wrote.

Deleting a worktree is permanent. Phoenix refuses if the worktree still holds uncommitted changes
or commits that exist nowhere else, and tells the session exactly what is at risk; the session has
to insist before anything is lost. A branch you named yourself is only deleted if the session asks
for it _and_ Phoenix can prove the branch was merged — the branch, its remote, and a merged pull
request all pointing at the same commit. Squash merges rewrite history, so "looks merged" is not
good enough; if the proof does not hold, the branch stays and the session is told which commits
disagree.

Cleaning up several sessions at once is safe: Phoenix removes worktrees from one repository one at
a time, because git allows only one writer per repository. If a git process elsewhere on your
machine is holding the repository open, Phoenix says which lock file is in the way instead of
forcing its way through.

## The Sessions Panel

Everything a session spawns is also visible to you, not just to the agent that spawned it. Open the
right-hand panel and choose **Sessions** to see that thread's own roster:

- **Active** lists the sessions still in play — what each one is working on, whether it is waiting
  on you, and its provider, model, and branch.
- **Settled** is the history: the sessions that finished, and whether their worktree has been
  reclaimed (a session whose worktree is gone cannot be resumed). Archiving a session removes it
  from this list, as it does from the sidebar.

Every row opens that session's chat, so you can drop into a spawned session, read what it did, and
come back. The panel is per thread — it shows the sessions that thread spawned, not every session
in the environment. A spawn also leaves a row in the chat itself, which links to the same place.

## Limits

Orchestration is bounded so a runaway agent cannot overwhelm your machine:

- A session can have at most 8 active (unsettled) spawned sessions at a time — settling a finished
  child frees its slot as soon as its process has stopped.
- A session can retain at most 32 spawned children total (active + settled, not yet archived) — a
  separate limit from the 8-active cap, meant to stop settled children from accumulating forever;
  archive settled children to reclaim capacity.
- Spawn chains go at most 3 levels deep.
- A spawned session never gets a more permissive permission mode than the session that spawned it.

## Turning It Off

Settings → General → **Session orchestration** disables the feature for the whole environment. The
switch applies immediately, including to sessions that are already running.
