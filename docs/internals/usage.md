# Usage history and account identity

Usage scans native history stores on each environment and returns priced buckets through the existing typed Usage request. It includes activity outside Phoenix. The client merger deduplicates shared physical stores before calculating totals.

## Store membership

`UsageSource.configuredInstanceIds` lists the current environment-local provider instances that resolve to that history store. This optional additive field uses the existing Usage contract version. Older summaries omit it, which means membership is unknown. It is not a historical account ID or a basis for merging subscriptions across machines.

The provider home resolvers retain every instance ID when grouping identical paths. The scanner reports one source and scans the store once. Source IDs are response-local; use the existing fingerprint for cross-environment deduplication. Display labels and verified subscription identity come from provider availability, not directory names.

- Claude instances select their configuration directories through `homePath` / `CLAUDE_CONFIG_DIR`.
- Codex direct homes can keep separate history. Auth overlays keep credentials private while linking sessions to a shared home; every overlay is listed on that shared source.
- OpenCode instances resolve their database using their configured process environment.
- Grok instances resolve `GROK_HOME`, falling back to the process environment’s user home plus `.grok`.
- Cursor is outside the current Usage history provider contract.

Separate stores can be broken down individually. A current login alone does not prove the owner of every historical record in that store. Shared-store totals must never be assigned in full to each listed account. Historical account attribution requires evidence recorded with the usage, particularly when accounts can change between turns.

## Environment totals

`mergeUsage` exposes `environmentTotals` alongside provider, model and time totals. Each row contains the environment’s contribution after deduplication, including cost, tokens, cache input, output, records and distinct active sessions. Their sums match the overall totals. A duplicate-only environment contributes zero and remains represented; use the existing duplicate-source and coverage information to explain why. Incompatible summaries remain in `staleEnvironments` and do not contribute.

These are active-session counts in the requested window, not session creation counts. The existing per-source distinct counts avoid summing a session repeatedly across days and models.

Web and mobile use this same merger; desktop inherits web. The wire changes are additive and do not change local, relay or tunnel transport. Compatibility for older contracts and missing source IDs remains at the data boundary.

## Account directory

`buildUsageAccounts` in `packages/client-runtime/src/usage/accounts.ts` joins existing provider-status and availability snapshots to history source membership. Web and mobile expose its result as `useUsage().accounts`; on web it remains global when the historical environment filter changes. No extra endpoint, transcript scan or quota refresh is required.

An account row carries display emails and every environment/instance membership. Memberships retain the provider snapshot, including authentication method, plan label, installed version, update advisory and last check time. They also reference associated history sources without assigning that source's cost to the account.

Rows merge only when matching driver-scoped native identities are present, authentication is confirmed and the reading is not a failed-refresh snapshot. Email, display name and plan never form grouping keys. Different organisations remain separate when the provider reports different identities. Logged-out or unknown-auth instances do not inherit the previous login's email or account identity. Disabled instances remain visible.

Codex/Claude subscription email is supplied by the existing status adapters. Email does not imply a verified cross-environment grouping ID; where that ID is absent, the directory retains a separate instance row. OpenCode and Grok can use configured names and authentication labels without fabricating email addresses. Missing older source-membership metadata remains unknown. Native mobile and web page rendering consume this same directory as the Usage screens migrate.

## Account navigation and history selection

The web `/usage` search parameter `account` anchors navigation to an environment/instance pair. `findUsageAccount` resolves that member into the current directory group, so gaining or losing verified grouping information does not invalidate a bookmarked instance. Unknown or removed selections do not fall back to displaying all-account totals.

`scopeAccountHistory` restricts buckets and source-level distinct session counts together. A source must identify all configured instances using it, and all must belong to the selected account on the reporting environment. Unknown source IDs and stores shared with a different account remain in the overall view. Deduplication across environments still runs through `mergeUsage` after scoping.

Usage swaps the thread sidebar through `AppSidebarLayout`, regardless of the thread-sidebar preference. Its sidebar reads cached provider status/availability without scanning history. The footer update indicator observes provider projections without triggering probes. Account editing reuses `ProviderSettingsPanel` with initial environment and instance selection, preserving its access gates and update commands.

## Native sessions and Phoenix attribution

`UsageSummaryInput.includeSessions` opts into `sessionUsage`. Each native session contains its per-model tokens, cache reads/writes, priced cost and unpriced-record count within the requested window. The aggregator creates this detail from the same accepted records as overview buckets, after global deduplication and window filtering; it does not run a second pricing or transcript scan. Session keys include source, provider and native session ID. Records without native identity remain in overview totals.

Overview requests omit the detail payload. The server's in-flight request key includes both the detail flag and caller contract version so differently shaped responses cannot share a narrowed result. Source deduplication and account scoping apply equally to session detail and overview buckets. Older compatible environments can contribute overview totals without session detail; clients expose that coverage explicitly.

Migration 61 creates `usage_session_links`, retaining explicit native-session-to-thread links across provider runtime resets and deletions. The provider directory extracts native identity from supported resume cursors: Codex `threadId`, Claude `resume` (not its Phoenix `threadId`), and version-1 Grok/OpenCode `sessionId`. Existing valid runtime cursors with an explicit instance ID are backfilled. New links are persisted atomically with the runtime binding. Changing provider or instance without an explicit new cursor clears the old cursor.

The attribution query joins recorded links to current thread/project metadata, including the project favicon and workspace root. Matching is constrained to the source's configured instances. Competing links to different Phoenix threads remain ambiguous, rather than awarding all historical cost to one of them. Deleted or removed stores and unknown historical membership cannot be reconstructed from current login. This is thread linkage, not proof of which subscription paid for every turn.

The shared client `buildUsageReport` groups linked native sessions by environment-local thread or project. Unlinked and ambiguous history remains visible; web/desktop render paginated tables using the existing remote-aware project favicon component. Mobile uses the same account scope, report builders, chart series and geometry with native controls.

`firstActivityAt` and `lastActivityAt` bound accepted usage within the requested period. Neither is a session creation timestamp. `UsageThread.createdAt` is the actual Phoenix thread creation time, but the active-session report omits threads without in-window usage and must not be used as a complete creation-count series. Costs in these reports are window totals, not a persisted lifetime thread-cost ledger.

## Trend and creation series

`MergedUsage.buckets` retains owned per-source buckets for shared provider/account/environment/model series. Group changes preserve totals. Account series use exclusive current store membership; shared or unknown membership is grouped explicitly as unassigned.

Session detail includes per-period cost/token totals for project trends. `threadCreations` is a separate query of projection creation timestamps, including zero-usage threads, with the original creation event's configured instance ID where known. Calendar-day and exact rolling-hour filtering happens on the environment. `threadCreationSource` identifies the physical state directory so two servers reading the same database do not double creation counts. The client reports missing creation coverage and does not infer creation from token timestamps. Instance-to-provider display uses the current configured directory; removed instance identities remain unknown.

Codex runtime limit snapshots preserve `limitId` as scope for model-specific pools, including Spark, so sparse updates do not replace the main allowance. Compact Claude quota selection recognizes the native `all-models` weekly scope. The old Capacity lens and presentation-only derivation are removed; settings retains its small native-limit bars.

Attribution lookups are restricted to the requested native sessions and configured instances, in bounded SQLite batches. Numeric store deduplication is separate from thread-link evidence: duplicate readers can supply a unique environment-local link or establish ambiguity. Archived and soft-deleted threads remain in historical accounting; deleting a conversation does not erase its spend or creation history. Recreated draft IDs use the newest creation event for their current projection.
