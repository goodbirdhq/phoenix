# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Subscription limits

Above the token charts, **Subscription limits** shows the limits your providers report themselves —
one card per connected, signed-in account, with a bar per window (Claude's current session and its
weekly pools, Codex's two windows) and when each resets. Phoenix shows what the provider says and
never adds two accounts' limits together: if the same account is reachable from more than one
environment, its card names them and shows the newest reading.

Opening the Usage page shows the latest retained provider reading. The refresh button rescans every
connected environment for the selected date range (including **Past 24h**) and explicitly asks
eligible, signed-in providers for a new quota reading. A provider refresh is shared per instance:
clicks within thirty seconds reuse the in-flight or recent reading instead of starting another CLI
request. Providers that publish no limits, accounts that are not confirmed as signed in, and
unknown provider states are left out rather than shown as empty cards. If a previous provider
reading expires, Phoenix keeps the account card with an expired-reading notice but removes its
quota bars until a refresh succeeds. Reading limits never starts an agent turn and never spends
your quota.
