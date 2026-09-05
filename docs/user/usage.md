# Review usage

The Usage page combines Codex, Claude Code, OpenCode, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear. Each configured Grok instance’s environment overrides determine which history directory is scanned, so instances using separate directories are included. Shared history directories are scanned once.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Historical activity starts with **All environments** selected; choose one
environment to inspect only its totals, chart, and breakdown. Refresh usage rescans the selected date range and checks eligible accounts’ current limits. The button shows Checking while requests run and Checked when they finish; any unavailable readings remain labelled.

## Accounts and environments

Usage has its own sidebar with search, provider filters, and an add-account button. Only enabled provider accounts appear; disabling an account does not remove its recorded usage from All accounts. Select **All accounts** for combined history or a configured account for its linked history. Account headers show the provider, a concealed email when available, and the reported subscription label. Select the eye control to reveal or hide the email.

The **Overview** tab shows activity over time; **Models** shows the model breakdown. **Projects** and **Threads** show usage during the selected period, including project icons, models, tokens, cache reads and writes, and estimated API cost. A thread can combine several native provider sessions. Account pages also have an **Environments** tab with installed versions, sign-in or offline status, last check time and available usage totals. Provider updates appear beside the installed version, on the Environments tab, and as an arrow on the sidebar’s Environments button.

**Edit** opens provider settings. When an account is configured more than once, choose the environment and instance to edit. Existing permissions still apply.

Some history stores are shared by different accounts, and older environments may not report which instances use a store. That history stays in All accounts. Account pages include only stores linked exclusively to that account’s instances. A linked directory describes where history is stored; it does not prove which login produced every older record. A dash means an account total cannot be established, rather than zero activity.

Provider history without a matching Phoenix conversation appears as an **Unlinked session**. This can include sessions started outside Phoenix or older history without a recorded link. Its usage stays in the totals; Projects groups it under **Unattributed usage**. Local synthetic messages with no model call do not appear in usage reports. Shared history linked to more than one thread is marked accordingly. Some older environments cannot supply session detail; their totals still appear in Overview. Table costs cover the selected period, not lifetime thread cost. The separate creation chart uses actual thread creation records.

## Limits and charts

Account Overview pages show the limits the provider reports. Claude can show a current-session allowance and multiple weekly pools. Codex keeps its main allowance and Spark separate. OpenCode is shown as pay as you go when a balance or budget is not reported; Grok shows an unavailable state until it reports limits. Historical API estimates do not represent subscription fees or an account balance.

Hover over Usage in the sidebar to see a compact account summary. A current session limit replaces that account's bars with its limit/reset message. The summary has no controls; click the Usage button to open the page. Limits also have their own refresh action when the provider supports it. Otherwise the button is disabled with an explanation; limits update when the provider reports them. The account panel, sidebar and hover summary share refreshed readings. If a provider cannot confirm its limits, the compact bars retain its last reported values with a Last known label; these are not treated as current session locks.

Overview charts switch between providers, configured accounts and environments. Shared history that cannot be assigned to one account remains labelled Shared / unassigned. Models and Projects show their own cost/token trends. All trends use curved lines and subtle areas.

The Threads chart counts Phoenix threads created during the selected period, including those with no token usage, and can split by provider on All accounts. Native sessions created outside Phoenix are not part of this creation count. Older environments that cannot report creation history are identified separately.

Web and desktop share this layout. Mobile provides the same report tabs and filters with touch controls and the same line/area charts.

## Warnings in chat

When the account a thread runs on has spent 90% or more of one of its windows, a single line appears
in that thread's chat: the account, how much of the window is gone, and the local time it
resets. It is the same reading the Usage page shows, so it costs nothing extra to collect and never
asks a provider for a fresh one on its own.

Dismiss the line and it stays gone for that thread until the window resets; the next window warns
again. Other threads on the same account keep their own warning. A reading the provider could not
confirm remains visible on the Usage page for context, but it does not drive chat warnings or
migration suggestions until a current reading arrives.

Historical usage includes archived and deleted Phoenix threads: removing a conversation does not remove its recorded token usage or API cost.
