# Usage and limits

The desktop and web Usage page combines Codex, Claude Code, OpenCode, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here. This guide describes the desktop and web interface; the separate mobile app currently retains its Threads report, which groups native sessions by Phoenix conversation.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear. Each configured Grok instance’s environment overrides determine which history directory is scanned, so instances using separate directories are included. Shared history directories are scanned once.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update the chart and its breakdown; headline totals keep cost, tokens and sessions visible. Historical activity starts with **All environments** selected; choose one
environment to inspect only its totals, chart, and breakdown. Refresh usage rescans the selected date range and checks eligible accounts’ current limits. The button shows Checking while requests run and Checked when they finish; any unavailable readings remain labelled.

Usage opens on **Overview** the first time and remembers your chosen view. **Limits** remains
available for account allowances and reset times.

Costs distinguish provider-reported usage from model-priced estimates; neither is necessarily
an invoice or subscription bill. **Unpriced** means usage was recorded without a known cost.
A partial total is marked as incomplete, and unavailable history is shown as a dash rather than
as zero spend.

## Accounts and environments

Usage has its own sidebar with search, provider filters, and an add-account button. Only enabled provider accounts appear; disabling an account does not remove its recorded usage from All accounts. The sidebar shows account and environment counts and each account’s estimated API cost for the selected period and environment. Shared or unassigned history is excluded from account costs. Codex has separate main and Spark bars; Claude shows its weekly pool and a session warning at 90% used. A confirmed session limit replaces the bars with its status. Unreported allowances or pay-as-you-go balances are labelled unavailable. Select **All accounts** for combined history or a configured account for its linked history. Account headers show the provider, a concealed email when available, and the reported plan label. Select the eye control to reveal or hide the email.

The **Overview** tab shows activity over time; **Models** shows the model breakdown. **Projects** and **Sessions** show usage during the selected period, including project icons, models, tokens, cache reads and writes, and estimated API cost. Each Sessions row represents a native provider session; one Phoenix conversation can have several sessions. Account pages also have an **Environments** tab with installed versions, sign-in or offline status, last check time and available usage totals. Provider updates appear beside the installed version, on the Environments tab, and as an arrow on the sidebar’s Environments button.

**Edit** opens provider settings. When an account is configured more than once, choose the environment and instance to edit. Existing permissions still apply.

Some history stores are shared by different accounts, and older environments may not report which instances use a store. That history stays in All accounts. Account pages include only stores linked exclusively to that account’s instances. A linked directory describes where history is stored; it does not prove which login produced every older record. A dash means an account total cannot be established, rather than zero activity.

Provider history without a matching Phoenix conversation appears as an **Unlinked session**. This can include sessions started outside Phoenix or older history without a recorded link. Its usage stays in the totals; Projects groups it under **Unattributed usage**. Local synthetic messages with no model call do not appear in usage reports. Shared history linked to more than one thread is marked accordingly. Some older environments cannot supply session detail; their totals still appear in Overview. Table costs cover the selected period, not lifetime session cost.

Limits also identifies accounts as **Subscription**, **Pay as you go**, **Enterprise**, or
**Unknown**, using information reported by the provider. Account names do not determine the
type. Older servers or providers without that information show Unknown.

## Limits and charts

Account Overview pages show the limits the provider reports. Claude can show a current-session allowance and multiple weekly pools. Codex keeps its main allowance and Spark separate. Refresh limits requests a fresh account reading using that configured account’s Codex home, without starting a conversation. OpenCode token and cost history refreshes normally, but its pay-as-you-go balance is not reported by the current integration. Grok reads its included credit allowance and weekly or monthly reset through its billing API, without creating a conversation. This requires a signed-in Grok CLI that supports the billing extension. Unavailable quota controls explain the connection’s limitations rather than claiming that a balance or allowance was checked. Historical API estimates do not represent subscription fees or an account balance.

Hover over Usage in the sidebar to see a compact account summary. A current session limit replaces that account's bars with its limit/reset message. The summary has no controls; click the Usage button to open the page. Limits also have their own refresh action when the provider supports it. Otherwise the button is disabled with an explanation; limits update when the provider reports them. The account panel, sidebar and hover summary share refreshed readings. If a provider cannot confirm its limits, the compact bars retain its last reported values with a Last known label; these are not treated as current session locks.

Overview charts switch between providers and configured accounts. Use the environment selector to scope the history. Shared history that cannot be assigned to one account remains labelled Shared / unassigned. Models and Projects show their own cost/token trends. All trends use curved lines and subtle areas.

The Sessions chart counts active provider sessions in each interval, based on recorded activity. It does not claim to count session creation. A session active on several days appears on each of those days. Older environments without session details keep their overview totals and show a detail-coverage message.

Web and desktop share this layout. Mobile retains its own Usage interface and Threads grouping.

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

An account’s **Refresh limits** button checks only that account’s connected environments. The main refresh checks usage history and all eligible accounts. Completion feedback belongs to the action you clicked: failed or unconfirmed reads say **Could not confirm**, while automatic refreshes do not display a manual success check. Known unsupported quota APIs are labelled unavailable; a manual main refresh can check again after a CLI upgrade.

Known accounts show static skeleton bars while limits load. Existing readings remain visible during refreshes and when an environment goes offline. Account rows and the Usage rollover keep their height as loading completes. An information indicator beside a two-bar account explains refreshing, stale or offline readings without moving the rows below it.

Provider edits share one draft across General, Environment variables, Configuration and Models. Save waits for the selected environment to confirm the settings; a failed save preserves the draft. Cancel discards unsaved changes.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex accounts with banked
reset credits show a ticket count and the **Use reset** action in the account details. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

If a window looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.
