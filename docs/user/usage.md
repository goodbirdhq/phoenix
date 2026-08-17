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

Opening the Usage page, and its refresh button, asks each signed-in provider for a fresh reading —
at most once every thirty seconds per account. Providers that publish no limits, and accounts that are not signed in, are left
out rather than shown as empty cards. Reading limits never starts an agent turn and never spends
your quota.
