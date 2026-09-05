# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the Phoenix server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Search and filters

The conversation sidebar has one row for search, filters, and the blue **New thread** button.
Open the filter menu to narrow conversations by projects, environments, status, provider accounts,
or models. Select several values within a category to match any of them; different categories
combine to narrow the results. Selections apply immediately. The filter badge counts active
categories, and **Clear filters** restores the full list.

Project settings are available from the wrench beside each project in the filter submenu.
**New project** is in the same submenu. Provider accounts belong to their environment, so selecting
an account on one machine does not include a same-named account on another machine. The model
list follows the selected accounts and includes models used by existing conversations.

Status filters include pending approval, awaiting input, waiting on a parent, working, monitoring,
failed, and ready, plus unread, woke, pinned, snoozed, and settled. Drafts follow project,
environment, account, and model filters; they have no agent status yet. Search works within the
current filters, including collapsed and settled conversations.

## Sidebar navigation

The bottom navigation opens **Agents**, **Pull Requests** (when supported), **Schedules**,
**Usage**, and **Environments**. The selected destination shows its name and a highlight.
**Agents** returns to the conversation you last viewed.

The **Settings** button opens a menu with **All settings**, General, Appearance, Keybindings,
and Providers shortcuts. In the desktop app, **Check for updates** is in this menu; an available
update adds a badge to Settings and the update action. Inside settings pages, **Back** returns
to the destination you came from.

## Session hierarchy

When a session spawns other sessions, the sidebar can nest them instead of listing everything
flat. Turn on **Sidebar session hierarchy** in Settings, under General. The switch only appears
while **Session orchestration** is on, because nothing spawns children without it.

On web and desktop, each thread has a provider avatar strip beside its branch. With hierarchy
on, a parent's strip includes its whole team: the parent first, then its descendants. Up to six
avatars are visible, followed by a circular overflow count. Click the strip or count to expand
or collapse the children. A thread without children has one avatar; click it for session details.
Hover a team strip for model, account, and environment details for every member.
Hover a thread title for its branch and worktree details. The avatar strip overlaps more tightly
at narrow widths to keep space for branch names.

Collapsed rows show the most actionable status in their subtree: a decision first, then input,
then failure, followed by waiting on a parent, working, monitoring, and ready. Click a review action to open the thread
that needs it. Working teams show the number of working sessions before the dotted indicator;
ready threads show a green check. Expanded rows show their own status, while each child shows
its own status or summarizes its children if collapsed. Counts always include every descendant,
including a child that is also pinned, once.

Children expand recursively and keep their branch visible. Indentation stops after four levels
so deep trees keep room for their titles. Completed children remain visible until settled.
Hover a row to show controls beside its title, focus them with the keyboard, or use its options menu to settle, snooze,
pin, or manage the thread. Snooze retains the existing wake presets and Wake now action.

Pinning a child moves its row to the existing pinned section. Its project remains visible and
**From [parent title]** replaces its branch. Hover the tree icon to unpin it. Pinned threads keep
the order you dragged them into, and can expand their own children. The snoozed shelf stays
ordered by what wakes next, and the settled tail stays in history order. A child whose parent
is snoozed, settled, archived, or outside the current project filter returns to the top level.
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
are identified in the expanded team count, even though their rows live in the pinned section.
