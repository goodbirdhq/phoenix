# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

On web and desktop, drag the sidebar edge to resize it. Agents, Pull Requests, Schedules, Usage,
Environments, and Settings share the saved width on that client. Double-click the edge to reset
the width for every page.

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Phoenix stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

**Attention ordering** is on by default, bringing threads that need your attention forward.
Turn it off in Settings to use **Manual ordering** and keep the positions you arrange.
An existing saved Manual preference is preserved. The drag-order behavior below describes
Manual ordering.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Phoenix server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Open a thread’s pull requests

Select the compact PR icon or count beside a thread to open its pull requests. When several
PRs are linked, choose one from the picker. Each row shows only that thread’s PRs: a parent
never includes its children’s PRs. This also works in the mobile sidebar and nested child rows.

## Search and filters

On web and desktop, the thread sidebar has one row for search, filters, and the blue **New thread** button.
Open the filter menu to narrow threads by projects, environments, status, provider accounts,
or models. Select several values within a category to match any of them; different categories
combine to narrow the results. Selections apply immediately. The filter badge counts active
categories, and **Clear filters** restores the full list.

Project settings are available from the wrench beside each project in the filter submenu.
**New project** is in the same submenu. Provider accounts belong to their environment, so selecting
an account on one machine does not include a same-named account on another machine. The model
list follows the selected accounts and includes models used by existing threads.

Status filters include pending approval, awaiting input, waiting on a parent, working, monitoring,
failed, and ready, plus unread, woke, pinned, snoozed, and settled. **Woke** finds unseen wakes,
including threads that are still working or need attention; those rows show their current status first. Drafts follow project,
environment, account, and model filters; they have no agent status yet. Search works within the
current filters, including collapsed and settled threads.

## Sidebar navigation

On web and desktop, the bottom navigation opens **Agents**, **Pull Requests** (when supported), **Schedules**,
**Usage**, and **Environments**. The selected destination shows its name and a highlight.
**Agents** returns to the thread you last viewed.

The **Settings** button opens a menu with **All settings**, General, Appearance, Keybindings,
and Providers shortcuts. In the desktop app, **Check for updates** is in this menu; an available
update adds a badge to Settings and the update action. Inside settings pages, **Back** returns
to the destination you came from.

## Session hierarchy

When a session spawns other sessions, the sidebar can nest them instead of listing everything
flat. Turn on **Sidebar session hierarchy** in Settings, under General. The switch only appears
while **Session orchestration** is on, because nothing spawns children without it.

On web and desktop, a project avatar leads each row, with its provider in a small badge.
Spawned sessions use the provider as their main avatar. Status rings and left-hand badges identify
working, ready, failed, decision, input, waiting, monitoring and snoozed sessions.

With hierarchy on, up to four child avatars appear beside the branch, followed by a circular
counter for additional children. Click the group to expand or collapse descendants. Hover it to
see session titles, providers and models. Hover a title or avatar for session details; click a
single session avatar to reveal its details, or an attention badge to open the session needing review.

Pull requests appear as a state icon before the branch, with their number and title in the tooltip.
Click the icon to open the pull request. Pinning stays in the thread menu.

Thread rows use compact spacing and truncate long titles. Read, unselected titles use regular
weight and muted text. Unread results, newly woken threads and selected threads use medium weight
and stronger text, including in the session details popover. Working status alone does not make
a title bold.

Collapsed rows show the most actionable status in their subtree: a decision first, then input,
then failure, followed by working, monitoring, and ready. Waiting on a parent stays on the child and does not change an ancestor’s status. Use the row’s options menu to review the thread that needs attention or dismiss a Woke notification. Working sessions have a rotating segmented ring (stationary with reduced motion);
ready threads have a green ring. Expanded rows show their own status, while each child shows
its own status or summarizes its children if collapsed. Counts always include every descendant,
including a child that is also pinned, once.

Children expand recursively and keep their branch visible. Indentation stops after four levels
so deep trees keep room for their titles. Completed children remain visible until settled.
Hover a row to replace its top-right status with controls, focus them with the keyboard, or use its options menu to settle, snooze,
pin, or manage the thread. Snooze retains the existing wake presets and Wake now action.

Pinning a child moves its row to the existing pinned section. Its project icon and provider badge identify it while its branch remains visible.
Hover or focus the avatar for its project and parent details; use **More → Unpin** to unpin it. Pinned threads keep
the order you dragged them into, and can expand their own children. The snoozed shelf stays
ordered by what wakes next, and the settled tail stays in history order. A child whose parent
is snoozed, settled, archived, or outside the current project filter returns to the top level.
When every child is pinned separately, the parent’s avatar group opens team details instead
of offering an expansion with no rows to reveal.
Search continues to find collapsed and settled threads.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by Phoenix.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While Phoenix is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

Expansion resets when a thread leaves the active or pinned list. Separately pinned descendants
remain included in their original team’s avatars and details.

## Mobile navigation and quick actions

On mobile, Search, Filter and New task sit above the conversation list. The footer opens Agents,
Pull Requests, Schedules, Usage, Environments and Settings. On wider screens it shows the selected
destination's name; smaller screens and larger text settings use icons with accessible labels.

Pull down from the top of the mobile conversation list to refresh sessions. This reloads the
selected environment, or all saved environments when no environment filter is selected. Existing
conversations remain visible while refreshing. The gesture works on empty lists and in the tablet
sidebar too. You can also choose Refresh sessions from the Filter menu without pulling.
If some environments are unavailable, sessions from reachable environments still refresh.

Swipe a conversation right to reveal Pin or Unpin, then tap the icon to apply it. Recent appears
below your pinned conversations and disappears when no conversations are pinned. Tap an agent
group to expand its direct children underneath the parent. Each child can expand its own descendants.
Pinned children appear in the pinned section and remain included in the original team's count and
details. Tap a session avatar, or long-press its avatar group, for full titles, providers, models and
environments in Session details. Select a session there to open it.

Mobile working rings rotate around a stationary identity. Rotation pauses with Reduced Motion,
when the app is inactive, or when its screen is no longer focused.

Swipe left to reveal the tick for Settle and Zzz for Snooze. A full left swipe settles the
conversation. Settled conversations offer Un-settle, and snoozed conversations offer Wake.
Available actions depend on the connected server and whether the conversation is currently busy.

Long-press a conversation for its actions. Snooze opens a sheet with available wake times.
Action and confirmation sheets show the conversation's avatar and keep options below the heading.
Cancel, the backdrop, a downward drag on the handle, or Android Back dismisses the sheet.
Deleting requires the explicit Delete conversation button and permanently removes its terminal history.

## Attention first

Turn on **Settings → General → Attention first** on web, desktop, or mobile to
move work that needs you to the top of the active thread list. It is off by
default. The setting is available with the current thread list; turn off the
legacy sidebar or legacy thread list to use it.

Decisions and actionable plans come first, followed by failures, unread results,
viewed results, work continuing autonomously, and quiet threads. Within each group, threads keep
their usual order. Turning the setting off restores the usual order immediately.
Pinned threads keep their manual positions, snoozed threads keep their wake order,
and settled threads stay in history.

With session hierarchy on, a parent's priority includes its visible descendants, even
when collapsed. Flat lists rank each session by its own requests. A child asking
for human approval can bring the family up. A child waiting for its parent, or
finishing work for its parent to process, does not count as a result for you to
review. A quiet parent stays below reviewable results while children are working
or have a newer result to hand back. A new result from the parent can
bring it up once that work is processed. Explicit decisions and failures remain
visible at the top even while other agents work.

Opening a completed conversation marks its result as seen on that client. Finished
sessions stay above running work after you read them, until they are settled or
start working again. Unread results come before results you have already viewed. Results
from conversations you have never opened also count as unread with Attention first
on. Read state is local to each client, and mobile saves the setting on each device.
Turning Attention first on in desktop or web does not enable it on your phone.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. On web and desktop, choose an environment at the top to change only
its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
