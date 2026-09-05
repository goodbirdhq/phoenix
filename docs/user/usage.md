# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Historical activity starts with **All environments** selected; choose one
environment to inspect only its totals, chart, and breakdown. Refreshing activity rescans the
selected date range independently from subscription capacity.

## Capacity

At the top of the page, **Capacity** shows which connected subscriptions are ready for another turn
and the quota windows your providers report themselves. It uses the same open summary, chart, metric
strip, and flat-breakdown layout as historical Usage instead of placing a set of cards inside the
page.

Capacity is organized by environment-local **Failover groups**. Instances in a group are routing
alternatives Phoenix can switch between; **Ungrouped** instances never switch automatically. Groups
with the same name in different environments stay separate. Switch between **Subscriptions** and
**Instances** to view distinct account capacity or the configured routing topology. Phoenix only
deduplicates accounts when a provider supplies a verified identity, and it never combines quota
percentages across accounts or environments.

Phoenix remembers the latest provider reading on the environment that collected it, so returning to
the page can show known values immediately. Configured groups and instances appear before the first
reading finishes, with the same static placeholders as the Usage graphs and tables. Missing or stale
readings refresh automatically when the page opens or regains focus, and provider-published updates
flow into the page while it is open. There is no continuous polling.

Capacity has its own refresh action. It asks only eligible, signed-in providers whose reading needs
revalidation; it does not rescan historical transcripts. Concurrent requests for one instance share
one provider probe, and requests inside the provider cooldown reuse the recent result. A stale or
failed refresh keeps the last known account and quota values visible but marks their readiness as
unknown until a current reading arrives. Reading limits never starts an agent turn and never spends
your quota.

## Warnings in chat

When the account a thread runs on has spent 90% or more of one of its windows, a single line appears
in that thread's chat: the account, how much of the window is gone, and the local time it
resets. It is the same reading the Usage page shows, so it costs nothing extra to collect and never
asks a provider for a fresh one on its own.

Dismiss the line and it stays gone for that thread until the window resets; the next window warns
again. Other threads on the same account keep their own warning. A reading the provider could not
confirm remains visible on the Usage page for context, but it does not drive chat warnings or
migration suggestions until a current reading arrives.
