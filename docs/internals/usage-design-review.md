# Usage design review

The desktop Usage reference is [Phoenix in Paper](https://app.paper.design/file/01M1PXJYW6YGH9Q0MEVZA3HSN1/E-3). Read editable nodes and their exported styles for measurements. Screenshots are comparison evidence, never implementation assets.

Run the worktree with the `test-t3-app` skill and keep its state and ports separate from other Phoenix instances. For visual iteration, unbundled Vite mode (`T3CODE_BUNDLED_DEV=0 vp run dev --share`) supports the development reference entry. Follow the emitted pairing URL for the real application. Pair another environment through the normal connection flow when real provider history is needed. Test settings writes against the disposable environment.

## Repeatable states

Open `/dev/usage-reference.html` on the worktree's web origin. This development-only entry renders the actual account navigation, quota panel and rollover components with deterministic provider readings. It is outside the production app's routes and build entry.

At 1440 × 900, switch through ready, loading, refreshing, stale, offline and exhausted. Run the repeatable assertions from the browser console (or `agent-browser eval`):

```js
await (await import("/dev/usage-reference-check.ts")).verifyUsageLayout();
```

Check both screenshot appearance and bounding rectangles:

- Sidebar width: 344 px, including its right border.
- All accounts: y=116, height=63.
- Provider rows: y=229, 325, 421, 517, 592; heights=90, 90, 90, 69, 69.
- Rollover: 320 × 429 with this five-account fixture, unchanged between states.
- Account quota region: 286 px, including pending and unavailable states.

The fixture's plain header and empty footer are placeholders for platform chrome. Verify the actual application header, collapse control, navigation footer and hover trigger in the paired client. macOS window buttons belong to Electron, not to the web implementation.

Use the same viewport, zoom, light theme, font-loading completion and content when comparing Paper with browser evidence. Wait for tooltips and dialogs to finish opening before capture. Inspect narrower widths and dark mode separately; matching a reference viewport must not remove scrolling or theme support.

## Integrated checks

Use real data to check All accounts and each provider, period and environment selection, Models search, Projects and Sessions search/sort, and environment rows. Offline status does not imply zero historical usage. Shared transcript stores contribute once to totals. Unknown account attribution remains unassigned instead of appearing as a guessed account total.

Open every provider-editor tab and all three add-provider steps. Verify fixed modal dimensions, draft retention across tabs, Cancel, acknowledged Save, and failed-save retention. Add/edit test instances only in the disposable environment.

The Sessions table preserves native provider session identities even when several belong to one Phoenix conversation. The Sessions chart shows **active sessions** in each interval: current history contracts do not reliably provide native session creation timestamps. Do not relabel conversation creation counts as provider session creation.

Keep screenshots and comparison output outside the repository. Focused regression tests live in `UsagePage.test.tsx`, `usageSidebarPresentation.test.ts`, and the client-runtime usage report/chart tests. Run scoped web typecheck and lint after integration; CI owns repository-wide checks.
