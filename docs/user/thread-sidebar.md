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
other connected devices.

If reordering is unavailable for one environment, update the Phoenix server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Session hierarchy

When a session spawns other sessions, the sidebar can nest them instead of listing everything
flat. Turn on **Sidebar session hierarchy** in Settings, under General. The switch only appears
while **Session orchestration** is on, because nothing spawns children without it.

With hierarchy on, a spawned thread sits directly beneath the session that started it, indented
and connected by a rail down the gutter. Nesting is recursive: a child that spawns its own
children nests another level, to any depth. Indentation stops after four levels so deep trees keep
room for their titles — the rows still nest, they just stop moving right.

Child rows are shorter than top-level cards: they drop the branch line, and their pull request
number and terminal indicator move up beside the status instead. Children keep their own worktrees
and branches — open a child to see its checkout.

Hierarchy applies to your active threads. Pinned threads keep the order you dragged them into, the
snoozed shelf stays ordered by what wakes next, and the settled tail stays in history order. A
child whose parent is pinned, snoozed, settled, or archived shows at the top level rather than
disappearing with it.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by Phoenix.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While Phoenix is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
