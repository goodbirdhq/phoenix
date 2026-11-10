# Sales

Sales shows what your sales engine reports and lets you act on its drafts: what needs you, the
drafts waiting for approval, the replies waiting for an answer, and whether the engine and its
mailboxes are healthy. Phoenix keeps no sales data. The engine and your CRM stay the record, and
the engine is the only thing that sends.

## Set it up

Open **Settings › Integrations**, choose the environment that should read the engine, and fill in
**Sales engine**:

- **Engine URL** and **Read token** (the engine's `SALES_READ_TOKEN`) show Sales in the sidebar
  footer on web and desktop.
- **Action token** (the engine's `SALES_ACTION_TOKEN`) lets Phoenix unapprove, edit and discard
  drafts, and carry approvals signed on an enrolled device. On its own it approves nothing.
- **Sales agents project** is the project whose checkout holds the sales workflows. Redraft and
  research runs start a thread there, the way a new thread in that project would start.

Tokens are stored by that environment's server and are never shown again. Changing the engine URL
clears both tokens, so enter them again for the new engine.

## Enrol a device

Approving in Phoenix is a press signed on a device you hold. Under **Settings › Integrations ›
Sales devices**, choose **Enrol this device**. Phoenix makes a key that never leaves this device,
sends the engine its public half, and shows a fingerprint. The engine posts a card to Slack:
check that its fingerprint matches the one on your screen, then press **Approve device**. Until
then the device can't approve.

Enrol and approve from a client the machine that runs your agents can't change: the hosted web
app, or the desktop app on another computer. Phoenix refuses to enrol or approve from a web page
served by a Phoenix server, and from a desktop app whose own server reads the same sales engine.
It can't tell when a remote connection reaches that same machine, so don't enrol from a client
running there.

Each browser and each desktop app is its own device. Clearing its site data removes the key; enrol
again to make a new one. **Revoke** stops a device from signing. Drafts it already approved stay
approved until you unapprove them.

## Approve drafts

**Outreach** lists the drafts waiting, grouped by campaign. Select one to read it, edit the body
(and the subject on a new thread), and approve it. Phoenix approves only the exact text on screen.
If the draft changed since you read it, Phoenix shows the new version and asks you to approve
again. Saving an edit withdraws any approval of the old version.

To approve several at once, tick them and choose **Approve**. Phoenix shows each ticked draft in
full, exactly as it will go, and approves them when you confirm. A draft that changed after you
ticked it is unticked and left for you to open; it's never approved from the old tick.

Other actions:

- **Unapprove** withdraws an approval before the draft goes.
- **Discard** drops a draft for good. It's never sent.
- **Redraft** starts a run that rewrites the draft with your note. Some drafts, such as a
  reply, are discarded first and drafted again; the form says so. If that run fails to start,
  the draft is already gone: start a new answer from the conversation.
- **Research** starts a research run for the draft's account.

The engine decides which runs a draft offers and names each button. The page links each run it
started. Keys: <kbd>J</kbd> and <kbd>K</kbd> move, <kbd>A</kbd>
approves, <kbd>E</kbd> edits. The command palette offers the same actions.

## Answer replies

**Conversations** lists everyone who replied, newest first, with how the engine read their reply.
Open one for the history across your mailboxes and the drafted answer. **Approve answer**, edit
it, redraft it with a note, or choose **No reply needed** to discard it. When nobody has drafted
an answer, **Draft an answer** starts one.

## Read the Home screen

The headline counts what waits on you across the work areas; a reply whose answer is drafted
counts once, as a draft waiting. Outreach and Conversations open their pages. The line below the
areas covers mailboxes, today's cold sends, and the engine's dispatcher. Phoenix asks the engine
about once a minute while Sales is open, and **Refresh** asks straight away.

If the engine is off, refuses a token, or can't be reached, Sales says which. When it already had
an answer, it keeps showing that answer, marked with the time it was read.

## What Phoenix can't do

Phoenix never sends email, and it can't approve without a press on an enrolled device. Agents and
scheduled tasks can't approve either. Holding sends, LinkedIn tasks and decision cards stay in
Slack.
