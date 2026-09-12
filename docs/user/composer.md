# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. If a draft is longer, Phoenix keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On mobile, an empty composer shows an interrupt button while the agent is working. Adding text
or an attachment replaces it with the send button. This applies to both compact and expanded
composers.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. Files upload directly to
the environment, where your agent can read, copy, or edit them by their file path.

Attachments upload as soon as you add them while connected to a server that supports uploads.
The send button becomes available after every upload finishes. Failed uploads can be retried or
removed. On mobile, tap **+** to open
the photo library from either the compact or expanded composer. When the connected server supports
file uploads, **+** opens a menu beside the button with **Photo Library** and **Choose Files**.
Videos use the server's file upload limit. You can also share photos, videos, and files into
Phoenix from other apps through the system share sheet. Select a received file on mobile
to preview it or open the system share options.

Tap an image or PDF before or after sending to open it. On iOS, images zoom from their thumbnail
into the native viewer. Pinch or double-tap to zoom, and swipe down or tap Close to return.
Use Share to save a copy or send it to another app. PDFs support page navigation and search.
PDF links in assistant responses open the same preview. On Android, images open in the image
viewer and PDFs open the system chooser.

Select a video attachment before or after sending to play it. Web and desktop use the browser's
built-in controls. On mobile, videos open in a full-screen player with native playback controls.
Supported videos show a thumbnail in the conversation and composer. On web, desktop, and iOS,
received videos stream from their environment as they play. Supported formats and codecs
depend on the browser or device; you can save an unsupported video to open it in another app.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the iOS photo library;
the image limit applies after conversion. On mobile, you can also send files to
Phoenix through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

Phoenix remembers the last provider, model, and model options you selected and reuses that
selection for new threads. A model configured in a project's settings overrides the remembered
selection for that project; resetting the project setting returns it to the remembered selection.

Model options shown as provider defaults remain display values until you choose them in Phoenix.
Phoenix only sends options you selected explicitly, so an unset reasoning level or service tier can
still come from the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Select a chip in the composer or a sent message to open the source thread, scroll to the response,
and highlight the quoted passage — including in older history. The
highlight pulses, holds for a moment, then fades on its own; press `Escape` to stop the navigation
or clear it early. If the source is unavailable or its text has changed, the saved quote stays
readable and Phoenix shows a warning.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Changing projects

On web and desktop, changing the project from a new thread keeps the current environment when that
project exists there. If it does not, Phoenix selects another environment that has the project.

## Notices above the composer

On web and desktop, loading and syncing statuses fill the available banner width beside the
stash tab. Task progress appears above the composer, while the timeline's working timer shows
only elapsed time.

On web and desktop, additional notices peek out above the attached banner. Hover over the peek
to reveal them, or focus **Show other notices** with `Tab` and press `Enter` or `Space`. Press
`Escape` to close the stack and return focus to that control. On a touchscreen, tap the peek to
open the stack. Interacting with the attached banner or composer does not open the stack.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use can download Apple's speech model and needs a network connection. Later transcription
works offline for that language. A recording can be up to five minutes long. Canceling voice input,
leaving the screen, or an audio interruption discards the new recording and keeps the existing draft
and attachments. Transcription runs on your device. Phoenix deletes the local audio file after
transcription or cancellation. It sends only the normal message text when you submit the draft.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, Phoenix hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

A skill token runs the skill wherever it sits in your message. Phoenix sends it to each provider in
the form that provider runs, so the text before and after the token is kept. Skills that only you may
start, and never the agent on its own, work the same way. A skill you switched off in the provider's
settings does not appear in either menu.

Provider commands such as `/compact` only run when they open the message, so the `/` menu offers
them only there. Phoenix's own commands, such as `/model` and `/plan`, and skills stay available on
any line. Send `/compact` in an existing conversation to reduce context usage when the provider
supports it; web and desktop also offer compaction from the context meter.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Phoenix opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Stopping a turn

Stop ends the agent's current turn. It also stops any background work that turn started, such as
subagents or long-running shells, so a runaway fleet cannot keep burning tokens after you have
asked it to halt.

Background work outlives the turn that started it. On web and desktop, Stop therefore stays
available on a thread whose turn has already finished while its agents are still running; the
mobile app can only stop a turn that is still in progress.

With Claude, a stop that cannot reach the agent leaves a note in the thread rather than appearing
to have worked. Other agent CLIs report stop failures less reliably; if a thread keeps working
after you press Stop, it is still running.

If an agent's process disappears entirely, Phoenix ends the turn and marks the thread as failed
rather than leaving it to look busy forever.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete Phoenix tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.
Workspace image and video links open the file viewer; links to media outside the workspace
open a media preview. Videos opened from the file explorer or a file-viewer tab also play inline,
streaming from the environment as needed rather than downloading the entire video before playback.
Video file references use a filmstrip icon, and visible previews load an initial frame when
supported but stay paused until you press Play.

Tap an image or PDF before or after sending to open it. On iOS, images zoom from their thumbnail
into the native viewer; pinch or double-tap to zoom, and swipe down or tap Close to return. PDFs
support page navigation and search. On Android, images open in the image viewer and PDFs open
the system chooser.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it; a browser or device may still
have a cached copy. Supported video formats and codecs depend on the browser or device.

Use Markdown image syntax to embed either kind of media:

```markdown
![Screenshot](/tmp/screenshot.png)
![Recording](/tmp/recording.mp4)
[Open recording](/tmp/recording.mp4)
```

Relative paths resolve from the thread's workspace. Absolute paths and `file://` links refer to
the environment's machine, even when you connect remotely or use your phone. Bare paths in
ordinary prose and paths inside code blocks stay text. Raw HTML `<video>` tags are not supported;
use the Markdown embed syntax above.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace, such as a
Markdown report in `/tmp`. These files open read-only in the file viewer, with rendered Markdown
available as usual; it cannot edit files outside the workspace. An HTML file outside the workspace
cannot load scripts, styles, or images from neighboring files, because it is served on its own.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically, and the choice persists like the rendered-Markdown toggle. HTML runs in an
isolated frame with no access to your Phoenix session. On desktop, the integrated browser
remains available from the same header for a full browser view.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
