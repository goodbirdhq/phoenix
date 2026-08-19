# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Every account you have configured counts. If an environment runs two signed-in Claude accounts,
each with its own config directory, the page reads both — including accounts you have switched
off, whose past activity is still yours. Two environments that share one machine still count that
machine's history once.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Subscription limits

Above the token charts, **Subscription limits** shows the limits your providers report themselves —
one card per connected, signed-in account, with a bar per window (Claude's current session and its
weekly pools, Codex's two windows) and when each resets. Phoenix shows what the provider says and
never adds two accounts' limits together: if the same account is reachable from more than one
environment, its card names them and shows the newest reading.

Each card carries its provider's mark, and a card named after an account is tagged with the
instance it belongs to — so a machine running two Claude accounts still tells you which is which.
When one account of a provider reports its quota, that provider's other cards are hidden if they
have no reading of their own; a provider that reported nothing anywhere still shows its card and
says so.

Opening the Usage page shows the latest retained provider reading. The refresh button rescans every
connected environment for the selected date range (including **Past 24h**) and explicitly asks
eligible, signed-in providers for a new quota reading. A provider refresh is shared per instance:
clicks within thirty seconds reuse the in-flight or recent reading instead of starting another CLI
request. Providers that publish no limits, accounts that are not confirmed as signed in, and
unknown provider states are left out rather than shown as empty cards. If a previous provider
reading expires, Phoenix keeps the account card with an expired-reading notice but removes its
quota bars until a refresh succeeds. Reading limits never starts an agent turn and never spends
your quota.

## Warnings in chat

When the account a thread runs on has spent 90% or more of one of its windows, a single line appears
in that thread's chat: the account, how much of the window is gone, and the local time it
resets. It is the same reading the Usage page shows, so it costs nothing extra to collect and never
asks a provider for a fresh one on its own.

Dismiss the line and it stays gone for that thread until the window resets; the next window warns
again. Other threads on the same account keep their own warning, and a reading a provider could not
confirm is labelled as the last known one rather than presented as current.
