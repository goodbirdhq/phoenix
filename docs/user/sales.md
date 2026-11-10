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
- **Action token** (the engine's `SALES_ACTION_TOKEN`) lets Phoenix hold, resume, edit and discard
  drafts, report LinkedIn tasks, and carry approvals signed on an enrolled device. On its own it
  approves nothing.
- **Sales agents project** is the project whose checkout holds the sales workflows. Redraft and
  research runs start a thread there with the project's thread mode and permissions.
- **Agent for Sales runs** is the provider and model those threads use, whatever the project's
  own default model. By default it's Claude Code, and Phoenix refuses to start a run when Claude
  Code isn't set up rather than hand it to another agent. Choose another agent here if your
  workflows don't need Claude Code.

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
approved until you withdraw their approval.

## Approve drafts

**Outreach** lists the drafts waiting, grouped by campaign; a scheduled draft shows when it goes.
Select one to read it, edit the body
(and the subject on a new thread), and approve it. Phoenix approves only the exact text on screen.
If the draft changed since you read it, Phoenix shows the new version and asks you to approve
again. If a new version appears just as you press Approve, that press only says so: read it,
then press Approve again. Saving an edit withdraws any approval of the old version.

To approve several at once, tick them and choose **Approve**. Phoenix shows each ticked draft in
full, exactly as it will go, and approves them when you confirm. A draft that changed after you
ticked it is unticked and left for you to open; it's never approved from the old tick.

Phoenix won't approve a draft with text you can't see as it will go: invisible characters, a line
break in the subject, a long run of blank lines or spaces, or a pile of accent marks on one letter.
It marks each one in the email, such as `⟨U+200B⟩`. Choose **Edit**, then **Remove hidden
characters**, delete anything still marked, and save. A reply keeps its thread's subject, so a reply whose subject has hidden text
can't be approved in Phoenix; reply outside Phoenix. Nor can a draft whose To address has
characters outside plain ASCII; correct the contact and draft it again.

Other actions:

- **Withdraw approval** takes your approval back before the draft goes, for good: it goes only
  once you approve it again. On a chase the autopilot approved, the same button is **Pause**, and
  **Resume** gives it back.
- If the send had already started, Phoenix says so: neither can stop a send under way.
- **Discard** drops a draft for good. It's never sent.
- The engine may offer runs, such as a redraft with your note or research on the account, and
  names each button. Some runs discard the draft first; the form says so. If such a run fails to
  start, the draft is already gone and Phoenix says why.

**Runs** lists each run started from the draft with its status, including after a restart, but
not runs you archived. When one finishes, Phoenix reads the draft again so a new version shows.
Keys: <kbd>J</kbd> and <kbd>K</kbd> move, <kbd>A</kbd> approves, <kbd>E</kbd> edits; change
them in **Settings › Keybindings**. The
command palette offers the same actions, and Pause, Withdraw approval or Resume where the selected
draft allows it.

## Answer replies

**Conversations** lists everyone who replied, newest first, with how the engine read their reply.
Open one for the history across your mailboxes and the drafted answer. **Approve answer**, edit
it, start one of the engine's runs on it, or choose **No reply needed** to discard it. When
nobody has drafted an answer, the engine may offer a run that drafts one.

## See today's automated sends

**Autopilot** lists what the engine sends today without a press, done and to come, grouped by
state: failed, retrying, needs your approval, held by the engine, paused, sending, scheduled and
sent. **Pause** holds a scheduled send and **Resume** gives a paused one back; **Pause all** and
**Resume all** do the same for every one of today's, one at a time, then sum up what happened. A
send that needs a look, such as one already going or refused, keeps its own note.
Resume can be refused: the autopilot sends only so many chases a day, so a paused chase may have
to wait until tomorrow, and a chase that changed since it was paused needs your approval in
Outreach. A paused chase also shows in Outreach, where approving it sends it as yours. Each send shows who it's to, which email it is, the mailbox, and why it's held, refused or
failed. Times are on your clock, with the contact's beside it when theirs reads differently.
**Away until** marks a contact whose out-of-office covers today; the engine doesn't pause for it,
so check whether the send should go. Turn on **Include approved by you** to see the drafts you
approved as well. A send that needs your approval got a normal draft card, so you approve it from
Outreach.

## Work the LinkedIn checklist

**To do** lists the LinkedIn connection requests and messages to send by hand, with the contact's
LinkedIn link, the suggested text and a button to copy it. Once you've done one, choose **Mark
sent** (the button names the contact, since it spends one of today's invites for good), or say
what happened instead (already connected, skip, and so on); Phoenix shows what the
engine recorded, and the heading shows how many invites today's budget has left. Tasks not posted
yet wait for invite budget and are folded away; a connection request there can't be marked sent
until it gets a place.

## Read campaign results

**Campaigns** shows, per campaign, the people the engine emailed, how many replied, how many
replies read as positive or declined, and how many bounced, then the same per email in the
sequence. These come from the engine's own sends and reply classifications, so they won't match
the funnel in your CRM, which also counts meetings.

## Check engine and mailbox health

**Health** shows what the engine's daily health message would say now, and any scheduled run that
hasn't finished. Below it, each mailbox shows its status, cold sends against its daily cap,
bounces, and its rest or next send. **Mail not read since** means the engine hasn't read that
mailbox's new mail for over three hours, so replies to it aren't showing up. **One bounce from
benched** means one more hard bounce and the engine stops sending from it.

## Read the Home screen

The headline counts what waits on you across the work areas; a reply whose answer is drafted
counts once, as a draft waiting. Each area opens its page. The line below the areas covers
mailboxes, today's cold sends, and the engine's dispatcher, and opens **Health**. Phoenix asks the
engine about once a minute while Sales is open, and **Refresh** asks straight away. Each area page
asks about once a minute while it's open, and Campaigns every five minutes.

If the engine is off, refuses a token, or can't be reached, Sales says which. When it already had
an answer, it keeps showing that answer, marked with the time it was read.

## What Phoenix can't do

Phoenix never sends email, and it can't approve without a press on an enrolled device. Agents and
scheduled tasks can't approve either. Decision cards, and a LinkedIn task's **Something else**
box, stay in Slack.
