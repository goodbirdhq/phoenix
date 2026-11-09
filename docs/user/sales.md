# Sales

Sales shows what your sales engine reports: what needs you, what goes out today, and whether the
engine and its mailboxes are healthy. It is read-only for now. Phoenix keeps no sales data; the
engine and your CRM stay the record, and approvals still happen where they did before.

## Set it up

Open **Settings › Integrations**, choose the environment that should read the engine, and fill in
**Sales engine**: the engine's URL and its read token (the value of `SALES_READ_TOKEN` on the
engine). The token is stored by that environment's server and is never shown again. **Sales**
then appears in the sidebar footer on web and desktop.

## Read the Home screen

The headline counts what waits on you across the work areas. Each row gives one area's status
and a few figures; the line below it covers mailboxes, today's cold sends, and the engine's
dispatcher. Phoenix asks the engine about once a minute while Sales is open, and **Refresh** asks
straight away.

If the engine is off, refuses the token, or cannot be reached, Sales says which. When it already
had an answer, it keeps showing that answer, marked with the time it was read.
