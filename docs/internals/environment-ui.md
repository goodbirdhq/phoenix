# Environment UI and visual verification

The web Environments destination also renders inside the desktop shell. Inspection is independent
of the active conversation: the URL owns the selected environment and tab. The React Native client
retains its separate environment-performance screen; desktop connection controls are capability
gated and cannot be inferred from a web browser running on the same host.

## Design rules

The reference is the **03 · Desktop · Production · Environments** page in
[Paper](https://app.paper.design/file/01M1PXJYW6YGH9Q0MEVZA3HSN1/T-0/2AAP-0).
Use its Overview, Projects, Providers, Connections and Access artboards, the finished Usage table,
and the shared dialog designs when changing this destination.

- The reference desktop frame is 1440 px wide, with a 344 px sidebar, 52 px top bar, 32 px content
  padding and 24 px section spacing. Sidebar resizing is a client preference.
- Use the existing Lucide icon system for environment types, tabs and metric labels. Laptop,
  desktop and server are explicit appearance choices, not guesses based on connection type.
  Environment titles and sidebar rows use the same stored choice. Provider marks come from
  `providerDriverMeta`; do not substitute generic server or language logos.
- Use Inter with its optical-size axis for titles and icon-bearing labels. `Environment Inter`
  loads the already installed standard variable font; ordinary copy uses the reference's system
  font. Scope these rules to the environment surface so Usage and other destinations retain their
  typography.
- Tables use the shared table components, quiet 31 px headers and a 47 px row baseline matching Usage. Allow rows to grow for a secondary line
  under names; use horizontal separators and aligned action columns. Keep wide tables horizontally
  scrollable on narrow windows. Do not bring checkout or branch controls into the project table.
- Project rows use the shared `ProjectFavicon`, including custom images and the folder fallback.
  Reserve a consistent 20 px image slot before the name and path.
- Provider tables show enabled accounts only. Disabled accounts can be restored through Add provider,
  preserving their saved configuration; they do not occupy rows in the active account table.
- Use 36 px text controls, restrained borders, and the shared dialog components. Environment editing
  has General, Access and Advanced tabs. Provider editing reuses the existing shared draft and
  General, Environment variables, Configuration and Models tabs. Immediate access actions do not
  become part of the environment's Save draft.

## Feedback cycle

1. Fetch the upstream branch and inspect the worktree diff before beginning. Preserve existing
   work. Read the current Paper artboards and computed styles; retain the reference screenshots
   outside the repository. Check the artboard's dimensions rather than resizing a screenshot to
   make it fit.
2. Run `vp run dev --home-dir <disposable-home>` from the worktree under a separately named process
   or user service. Give it a memory/CPU limit when the machine also hosts the maintainer's Phoenix.
   Capture the PID/service and the actual ports printed by the runner. Keep databases, credentials,
   provider configuration, and test projects in the disposable home. Never point this process at
   the maintainer's live userdata or kill processes by name.
3. Pair a dedicated browser session using that runner's startup pairing URL. Keep the URL and any
   generated access credentials out of screenshots and command output. For multi-environment
   checks, start a second disposable server on its own port and pair it through Add environment.
4. Iterate one component at a time: implement, run the relevant focused checks, inspect the real
   browser DOM and keyboard behavior, capture a screenshot, compare with Paper, and correct the
   measured difference. After changes to connection runtime or authentication, reload the browser
   before starting a journey so hot-reloaded atoms do not stand in for a fresh client.
5. Use `/environments-review.html` on the development web origin for repeatable Overview captures.
   It renders the production heading, tabs and overview components with fixed metrics and clock.
   It is a separate development entry, absent from the production app. Capture at 1440 × 1029 and
   compare the main pane starting at x=344. The fixture's chart samples, binary capacity units and
   server/Phoenix volume labels intentionally describe the implemented data contract; they are not
   copied illustrative values from Paper.
6. Compare at native scale using an alpha overlay and a difference image, followed by visual
   inspection. Check title/tab baselines, column starts, separators, control bounds, icon sizes and
   dialog padding independently. Mask only recorded dynamic data such as utilization and timestamps;
   a whole-image percentage is not evidence that interaction or typography is correct.
7. Exercise every tab with real populated and empty data, offline recovery, search/filter results,
   add/edit/cancel, permissions and failed mutations. Check both administrative and limited grants,
   including re-pairing the same saved environment without reloading. Verify that selected-project
   actions target that environment and that disconnect differs from remove. Check narrow windows,
   dark theme, tab keyboard navigation and dialog focus/scrolling.
8. Run targeted lint, typechecks and meaningful tests after integration, and inspect browser errors
   and the isolated services' restart/memory status. Record evidence paths, comparisons and platform
   limitations outside the worktree. Native SSH, WSL, Electron updates and host-network operations
   require their actual platform; a web screenshot cannot certify them.

The access API exposes active pairing links, not invitation history. The UI must not invent used or
expired rows to match sample artwork. QR sharing needs a non-loopback reachable endpoint; otherwise
show the pairing code and explain how to use it with the host's network address. Keep native window
controls platform-specific when comparing the macOS reference against a web or Linux client.
