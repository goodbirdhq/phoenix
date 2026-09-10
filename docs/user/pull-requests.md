# Pull requests

Open **Pull Requests** from the sidebar footer. The sidebar groups requests by your involvement and
shows their repository, state, review decision, check status, and available line counts. Search,
filters, sorting, and refresh stay above the list. The selected request fills the main workspace.

- **Summary** shows the description, reviewers, labels, checks, and comments.
- **Timeline** shows the conversation and commits.
- **Code** supports whole-request or individual-commit comparisons, stacked or split diffs, inline
  comments, replies, and review submission where supported by the host.

Switching detail tabs preserves the selected request and environment. Use the check indicator to
inspect checks without opening another request. A dash in the line counts means counts have not
been reported; it does not mean the request is empty.

Edit the title or description to open one editor for both fields. **Write** and **Preview** share
**Save changes** and **Cancel**. Unsaved edits survive navigation away and back during the current
app session. A failed save retains the draft. Closing a changed editor asks whether to discard it.
Removing a reviewer request has its own confirmation.

**New pull request** lets you choose a connected project and continue in a thread. Review the
changes there and use the thread's Git actions to publish. This step does not publish automatically.
Merge, close, reopen, draft, auto-merge, checkout, and agent handoff actions depend on the host's
capabilities and your permissions. Failed confirmed actions keep their confirmation open for retry.
