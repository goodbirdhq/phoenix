# Session Orchestration

An agent session can spawn other sessions and coordinate them. Ask a thread to split work across
providers — "spawn a Codex session to write the tests while you refactor" — and it can create the
sessions, hand each one a task, and collect the results without you shuttling messages between
threads.

## How It Works

Every session has tools for orchestration alongside its other Phoenix tools:

- **List providers** — enumerate the providers and models this environment can start, so the agent
  offers real choices instead of guessing. Disabled provider accounts and their models are omitted.
  Enabled accounts that are not ready are marked offline; agents can request only ready accounts.
  Starting a child with a disabled account is rejected even if the agent already knows its ID.
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
- **Message the parent back** — a spawned session can also raise its hand mid-work: ask a question,
  flag a blocker, or send an important update to the session that spawned it, without misusing its
  completion report as a chat channel. The message arrives like any other — waking an idle parent,
  or after the current turn of a busy one — and is always clearly marked as coming from an agent
  session, not from you. A child that cannot proceed without an answer can say so, and shows up as
  blocked-awaiting-reply when its parent checks on it.
- **Ping without disturbing** — a session can peek at a spawned session's live progress (status,
  current activity, plan step, whether a report has landed, and a best-effort usage snapshot —
  tokens, turn count, elapsed time) without starting a turn or interrupting it, for a cheap check
  between messages. It shows recent provider activity and messages still awaiting delivery
  confirmation. A long turn can legitimately leave messages queued; an old timestamp or missing
  confirmation alone does not prove the session is stuck. After a session ends, the peek names
  the reason it ended — quota exhausted, crashed, stopped, and by whom.
- **Post a report** — when a spawned session finishes, it posts a completion report: a status, a
  summary, and any artifacts (files, branches, PR links). The report shows as a card in the thread,
  and creates a visible report update in the spawning thread — no polling and no surprise agent
  turn. Several child reports are grouped together there; the parent can read the current report
  or session when it is ready to act. The report also carries the same usage snapshot, captured at
  the moment it was posted, so the spawning session can see what the work cost.

  The report inbox shows only what the spawning agent has not yet taken in. An update clears once
  the agent actually receives the report — in the turn that delivers it, or by reading it
  explicitly — and never because you opened the inbox or peeked at a child thread. Both the report
  and that read activity stay in the session history. The parent can still read a direct child's
  report after the child is archived; archived sibling reports are not available through this
  shortcut.

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

A spawned session never dies silently. If its process ends for any reason the spawning session did
not cause — quota exhaustion, a crash, a stop from the UI — the spawning session is told
immediately: why it ended, and whether its worktree still holds uncommitted or unpushed work that
exists nowhere else. This happens even for children spawned in quiet notify-only mode; opting out
of report chatter is not opting out of learning a child died. If the session also never posted a
report, Phoenix writes one for it: why it ended, what it was last doing, and a warning that the
work is probably unfinished. Those reports are labelled as Phoenix-generated, so you and the
spawning session can always tell them apart from a report the agent actually wrote.

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
  on you, and its provider, model, and branch. A session that asked its spawning session a question
  and cannot proceed shows as **Awaiting reply**, with how long it has been blocked; a session that
  died shows why — quota exhausted, crashed, stopped and by whom — not just that it stopped.
- **Settled** is the history: the sessions that finished, and whether their worktree has been
  reclaimed (a session whose worktree is gone cannot be resumed). Archiving a session removes it
  from this list, as it does from the sidebar.

A blocked session is also visible outside the panel: its own row in the sidebar (and in the mobile
thread list) is labelled **Waiting on parent** until a reply — from its parent or from you —
reaches it.

Every row opens that session's chat, so you can drop into a spawned session, read what it did, and
come back. The panel is per thread — it shows the sessions that thread spawned, not every session
in the environment.

Messages between sessions are attributed in the chat, on every platform: a message another
session sent into a thread renders as its own card naming the speaker ("the parent session, a
child, or Phoenix itself for death and wedge notices") and routes to that session — it never
looks like something you typed. A message that has not reached the agent yet — yours or another
session's — carries a small "queued — delivers after the current turn" marker until the agent
actually takes it in, and the mailbox lists everything still waiting alongside unread reports.

The conversation between sessions is also visible in the chat itself, on every platform. A spawn
leaves a "Spawned session" row that links to the child; a message sent to a spawned session leaves
a "Messaged session" row with a preview of what was said; and a spawned session's question to its
parent leaves a "Messaged parent" row (marked when it is blocked awaiting the answer). Each row
routes to the other end of the exchange — on mobile, tap the row to jump into that session.

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

Provider metadata warnings do not prevent starting a child when the provider is enabled, installed and usable. Disabled providers, signed-out accounts and unavailable or failed runtimes are rejected.

## Coordinating messages reliably

A busy session receives queued messages in order after its turn ends. A child asking a blocking
question should send it once and finish its turn so the parent's answer can arrive. Polling or
continuing to use tools in the same turn keeps the answer waiting.

Send one complete instruction and use a ping to check progress. Interrupting deliberately stops
current work; it keeps the existing message order and does not replace earlier instructions.
Claude uses native interruption when possible, retaining the conversation runtime. If background
work or a failed interrupt requires a restart, Phoenix confirms process exit before resuming.
An ordinary interrupt does not generate a session death notice.

A delivery receipt confirms that the provider accepted an input for a particular turn. It does not
prove that the agent understood or completed the instruction. For important approvals, request one
brief acknowledgement of the accepted scope. Avoid blindly repeating cancelled instructions after
an interruption; check recent work and the latest receipts first.

Terminal notices identify the ended episode and its time. They may arrive after the same thread
has resumed. Check its current state before restarting it or assigning duplicate work.
