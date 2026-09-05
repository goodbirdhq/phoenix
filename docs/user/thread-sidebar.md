# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each server stores its own copy of the automatic settlement settings and checks them even when no
web, desktop, or mobile client is connected. By default, it settles threads after three days without
activity and when their pull request merges. An eligible idle thread also settles when its pull
request closes. An open pull request blocks inactivity settlement. Active work, pending input, and
live background work keep the thread active. T3 Code settles from a closed or merged pull request
only when its timestamp is not older than the user's latest activity. If that timestamp is not
available, the inactivity rule still applies. A manual un-settle also keeps the thread active.

Change these rules in **Settings > General**. The change is written to every environment you are
connected to at that moment. An environment that is offline keeps its old value. When a connected
environment holds a different value, **Settings > General** shows a warning that names it. Choose
**Apply to all** to write your current values to every connected environment. The same applies to
the new-thread workspace mode and the source control writing style.

A settings change affects future settlement and does not reopen a settled thread. Settings saved
by older clients on one device no longer control this behavior.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices. On web and desktop, dragging under a filter places the moved thread
beside the drop target in the full pinned order; hidden threads keep their relative order.

If reordering is unavailable for one environment, update the Phoenix server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

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

On web and desktop, each thread has a provider avatar beside its branch. With hierarchy
on, the avatar is followed by a circular × total that includes the parent and all descendants.
Hover the conversation row or keyboard-focus the group to reveal up to five avatars, parent first. The counter shows
how many sessions remain hidden, or disappears when all are visible. The group collapses again
when you leave the row, unless the conversation is selected. Selected conversations keep their avatars expanded. Reduced-motion preferences disable the expansion animation.

Click the group to expand or collapse the children. A thread without children has one avatar;
click it for session details. Hover the group to see each member's icon, title, provider and model.
Working sessions have an outer spinner in the details popover. Badges identify failures,
decision or input requests, waiting on a parent, monitoring, ready and snoozed sessions.
Hover a thread title for its branch and worktree details.

Thread rows use compact spacing and truncate long titles. Read, unselected titles use regular
weight and muted text. Unread results, newly woken threads and selected threads use medium weight
and stronger text, including in the session details popover. Working status alone does not make
a title bold.

Collapsed rows show the most actionable status in their subtree: a decision first, then input,
then failure, followed by waiting on a parent, working, monitoring, and ready. Use the row’s options menu to review the thread that needs attention or dismiss a Woke notification. Working teams show the number of working sessions before the dotted indicator;
ready threads show a green check. Expanded rows show their own status, while each child shows
its own status or summarizes its children if collapsed. Counts always include every descendant,
including a child that is also pinned, once.

Children expand recursively and keep their branch visible. Indentation stops after four levels
so deep trees keep room for their titles. Completed children remain visible until settled.
Hover a row to replace its top-right status with controls, focus them with the keyboard, or use its options menu to settle, snooze,
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
