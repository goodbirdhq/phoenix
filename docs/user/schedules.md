# Schedule agent work

Schedules save an agent prompt and start it as a new thread at a future time or on a recurring
cadence. Each Schedule belongs to one environment and one project. The environment evaluates its
Schedules even when Phoenix clients are closed.

Open **Schedules** from the sidebar footer on web and desktop, or from **Settings** on mobile. The
page combines Schedules from every environment the client knows. Schedules from an offline
environment remain visible from the last cached view, but are greyed out and read-only until that
environment reconnects.

## Create a Schedule

A Schedule needs a short name, a text prompt, an environment, and a project. Choose either a single
future date and time or a recurring rule. Recurring rules can be assembled with the visual controls
or entered as a standard five-field cron expression.

Phoenix saves the selected time zone with the Schedule. The editor initially uses the browser's
time zone and previews the next three Occurrences before saving. Recurring rules cannot run more
frequently than every five minutes. If daylight saving time removes a selected wall-clock time,
that Occurrence is skipped; if the clock repeats a wall-clock time, it runs only once.

The editor also saves the provider, model, permission mode, interaction mode, workspace mode, and
base branch explicitly. Later changes to project defaults do not silently change scheduled work.
For Git projects, a new worktree based on the configured remote default branch is selected by
default. Shared workspace is available as an explicit choice. Worktree mode is not available for a
non-Git project.

## Triggering and threads

When an Occurrence is due, its environment creates a fresh thread and accepts the prompt as that
thread's first turn. The thread title combines the Schedule name with the local Trigger time. From
that point on it is an ordinary Phoenix thread: it can ask questions, request approval, settle,
resume, archive, or be deleted like any other thread.

Schedules serialize only the short Trigger step. Agent work from multiple Scheduled Threads can
overlap, and scheduled work does not block manually started work.

If an environment was offline, it catches up after restarting. For each recurring Schedule, only
its newest missed Occurrence is retained; older missed times are summarized instead of launching a
backlog. Retained work from different Schedules starts oldest-first.

## Manage a Schedule

- **Run now** starts a new thread immediately without changing the Schedule's state or future
  cadence. It is available for Enabled, Paused, Completed, and Failed Schedules while the owning
  environment is online.
- **Pause** stops the timing rule from producing Occurrences. Resuming begins with the next future
  time and never catches up the paused period.
- **Edit** replaces pending timing from the old definition. Giving a Completed or Failed one-time
  Schedule a new future time enables it again.
- **Delete** removes the Schedule and its compact Schedule history. Threads and worktrees it already
  created remain available and must be managed through the ordinary thread controls.
- **Duplicate** creates an independent Schedule on another online environment. Schedule ownership
  never moves in place.

Schedule history distinguishes Triggered, Failed, and skipped Occurrences and links Triggered
entries to their threads. A failure shown on the Schedule means Phoenix could not create the thread
and accept its first turn. Provider or agent failures after that point appear only on the thread.
The recent history page is shown first; while the Environment is online, use **Load older** to
page through earlier entries. Offline inspection uses the most recently cached page.

## Frequency and retention

A Schedule that runs every five minutes can create 288 ordinary threads per day and about 105,000
per year. Phoenix warns about this frequency but does not automatically delete Scheduled Threads or
their worktrees. Choose a cadence whose retained thread volume you are prepared to manage.
