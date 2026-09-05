# Provider architecture

> For maintainers. Using Phoenix? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Phoenix supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

`ProviderService.sendTurn` expands [assistant citations](./assistant-citations.md) into quoted
reference data before dispatching to any adapter. Bound user comments remain distinct from the quoted
assistant text. Persisted messages keep their serialized links.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

### Grok health check

`checkGrokProviderStatus` never opens an ACP session. It runs `grok --version`, then `grok models`
for login state and model slugs, then a single ACP `initialize` and reads models from
`_meta.modelState`. `authenticate` and `session/new` are skipped on purpose: `authenticate` can open
a browser login and `session/new` boots every configured MCP server, both of which made background
probes hang or surprise the user. A failed `initialize` degrades to `warning` with the CLI's model
list instead of persisting `error` over a working install. The built-in `grok-build` slug is the
CLI's product name, not an ACP model id. `applyGrokAcpModelSelection` treats it as "keep the
session's current model" and never sends it in `session/set_model`.

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and
text-generation helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent
borrowers share startup. The server closes 30 seconds after the last borrower releases it, or
when the provider instance closes. A failed or exited process can be started again on the next
use. An externally configured OpenCode server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password,
the client uses the password from the environment that the process inherits. External servers use
only their explicit provider password and never inherit the host's local password.

Every server connection must pass the authenticated `/global/health` check before inventory or
session operations start. The response must contain a valid version at or above 1.14.19. Local
owners cache this result for the lifetime of the spawned process. External actions check once when
they create their server connection, not for each model or SDK request.

Chat adapters keep their own server per thread. They register a thread-specific `t3-code` MCP
connection, while OpenCode stores MCP connections by directory. Sharing these chat servers
without changing MCP routing would let two threads in one directory replace each other's
connection.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

T3 Code does not own an external OpenCode process. Native configuration changes there can require
an external reload or restart before T3 Code's next refresh sees them.

The shared server's idle shutdown does not clear the catalog. Failed discovery keeps the last
known models, slash commands, and skills through the registry's existing merge rules. A successful
empty inventory is authoritative. Existing threads keep their explicit model identifier and
options when catalog metadata is missing; the catalog is not permission to choose a different
model for a thread.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Attachment access

The server stores uploaded attachments in its attachment directory, outside the project workspace.
`ProviderService` adds the absolute path of each attachment to the turn text, then passes every
attachment to the provider adapter. Each adapter decides what its provider ingests natively:

- Codex, Claude, Cursor, and Grok send images as native image inputs and skip generic files. For
  these providers, generic files reach the agent only as file paths in the turn text.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.

Claude receives the attachment directory as an allowed additional directory. Codex keeps its
configured sandbox policy, so access depends on that policy and the selected runtime mode. OpenCode
allows all paths in full-access mode and requests approval for directories outside the workspace in
restricted modes. Cursor and Grok use their own provider permission rules.

The server does not copy attachments into a project or bypass provider approval rules. If an agent
cannot read an attachment, the user must approve the access or select a runtime mode that permits it.

Updated attachment schemas tolerate unknown attachment members, but old image-only clients still
cannot decode messages that contain file attachments. Client file-picking rollouts must account for
this limit.

Do not run an old image-only server against state that contains file attachments. Replay decodes
each persisted event before projection. A file-bearing event can make `ProjectionPipeline` bootstrap
and `OrchestrationEngine` startup fail for the entire environment, not only the affected thread.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Conversation seeding

A thread that moves to another provider instance starts a fresh provider session, so the
conversation has to travel with it. It is rebuilt from Phoenix's own read model
(`projection_thread_messages`) by [`conversationSeed.ts`][seed] and handed to the adapter as the
optional `seed` on `ProviderSessionStartInput` — the only adapter interface change migration needs.
Provider-native session files are never the source: they are scoped to the account that wrote them.

The transcript is bounded (newest 60 messages, 60,000 characters, 8,000 per message). Over-budget
history is dropped oldest-first, and what went missing is logged and stated in the framed text
rather than silently capped. `brief` carries an origin-written handoff document instead of, or
alongside, the raw transcript; adapters treat both the same way.

Each adapter declares which of two tiers it uses in `capabilities.conversationSeeding`, so
orchestration can read the tier from `ProviderService.getCapabilities` before it migrates a thread:

| Tier             | Adapters                       | How the history arrives                                                                                          |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `native-history` | Codex                          | `thread/inject_items` puts the transcript in the app-server's model-visible thread history after `thread/start`. |
| `framed-prompt`  | Claude, Cursor, Grok, OpenCode | The transcript is framed in a `<phoenix-prior-conversation>` block on the first prompt of the new session.       |

Codex's native path is the typed one. The app-server also documents resume-by-history, but its
generated `thread/resume` params carry no `history` field, so a payload sent that way would be
stripped on encode and the thread would start blind while reporting success. When
`thread/inject_items` fails anyway — an older CLI that does not know the method — the Codex adapter
logs the failure and falls back to the framed prompt, because a migrated thread continuing on an
agent with no memory of it is the one outcome worth avoiding.

A session that resumes native provider history is never seeded: it already carries its own
conversation, and seeding it too would replay the thread into context twice.

## Subscription availability

`ProviderAvailability` ([`providerAvailability.ts`][availability]) is a per-instance snapshot of a
provider's own quota: a `status`, the native `source` that observed it, an optional verified
`account`, and zero or more `windows`. Two configured instances are two accounts, so Phoenix never
adds their quotas together and never infers a plan from token counts.

Snapshots reach [`ProviderService`][service] two ways:

- Passively, from native runtime events. Codex publishes `account.rate-limits.updated`; sparse
  updates merge window-by-window into the cached snapshot.
- Actively, when a client asks for `refresh`. `ProviderService.refreshAvailability` calls the
  adapter's optional `refreshAvailability`, which for Claude runs
  [`ClaudeUsageProbe`][usageprobe].

The Claude probe is the only collector that starts a process, so it is deliberately narrow:

- **Gated.** `serverGetProviderAvailability` and the `list_session_providers` MCP tool both refresh
  only an instance that passes `canRefreshProviderAvailability` — installed, enabled, and reported
  authenticated by its snapshot. The probe then re-checks with the CLI's own `claude auth status
--json` and stops there unless it reports a signed-in first-party account. An unauthenticated CLI
  is never started into a login flow, and a Bedrock/Vertex instance is never asked about a
  subscription it does not have.
- **Never a turn.** It runs `claude --print /usage --output-format json`, which the CLI answers
  locally. The whole claim that reading quota is free rests on that, so the envelope is only accepted
  when it positively reports both `num_turns: 0` and `total_cost_usd: 0` as finite numbers. A counter
  that is missing, non-numeric, or non-zero reads as unknown rather than as free quota data — a CLI
  version that stopped reporting them is exactly the case worth catching. Print mode also skips the
  interactive workspace-trust dialog, which an interactive PTY probe would otherwise answer on the
  user's behalf.
- **Contained.** The CLI runs in a cache-owned directory with `--safe-mode` (no hooks, MCP servers,
  plugins, or `CLAUDE.md`) and `--no-session-persistence`, under a timeout that kills the child.
  Output is capped while it is read, not after: a timeout alone would let a CLI that streams
  megabytes a second fill the heap before the deadline fires. A capped read is reported as truncated
  and treated as no reading, never as a panel that happens to parse.
- **Toolless, and order-proof about it.** `--tools ""` leaves the CLI nothing to run even if a future
  version stopped answering `/usage` locally. `--tools` is _variadic_: it keeps reading following
  arguments as tool names until the next option, so it has to be the last thing on the command line.
  Anything appended after its single empty value silently becomes a tool the quota read may run, and
  moving it ahead of the `/usage` prompt would feed the prompt itself to `--tools`. Appending it is
  the only way `ClaudeUsageProbe` builds an argv (`claudeUsageProbeArgs`), and a regression test pins
  its terminal position rather than trusting the order to stay right.
- **Line-ending agnostic.** The rendered panel is normalised CRLF-first, then redraw frames (a bare
  `\r` rewriting a line) are resolved. Doing it the other way round reads the empty string after a
  Windows line's trailing `\r` as that line's final frame and erases every quota row on that host.
- **Only as trustworthy as its exit codes.** `claude auth status --json` is believed only when the
  child exited 0. Its stdout on a failed call can still parse as a JSON object — a cached or
  half-written one — and trusting that would publish a verified account, and run `/usage`, on the
  strength of a call that failed.
- **Strict.** Only rendered quota rows (`Current session: 5% used · resets Aug 18, 1am
(Europe/Berlin)`) become windows, each row's percentage and reset read from that row alone. The
  panel's prose percentages ("75% of your usage was at >150k context") are never windows. Fractional
  readings (`0.5% used`, and `0,5%` in a comma-decimal locale) are read rather than skipped. Every
  weekly row carries an explicit `scope` — the shared pool is `all-models` however the panel words
  it, and each per-model pool gets its own — so the pooled and per-model quotas can never collapse
  into one identity in a dedupe or a render key. `testFixtures/claudeUsagePrint.json` is a live
  capture that pins this.

Reads apply five more rules:

- Refreshes are claimed atomically per instance under a 30s cooldown, so two clients clicking at once
  run the CLI once. A service-level permit pool applies
  `PROVIDER_AVAILABILITY_FANOUT_CONCURRENCY` across every entry point, including several concurrent
  targeted requests, so neither a burst of CLIs on the user's machine nor one slow instance holding
  up every other answer can bypass the bound. Provider snapshots advertise whether their runtime
  adapter actually owns a native refresh operation; clients never offer a no-op probe for the rest.
- Freshness is server-owned. A snapshot older than 15 minutes keeps its source, observation time,
  account, and last known windows, but its status becomes `unknown`. Capacity can therefore render
  immediately from the durable cache without treating an old bar as readiness; the client labels
  the retained reading unconfirmed and revalidates it. Retained windows are presentation context
  only: failover ranking, migration prompts, and chat warnings ignore them until confirmed. A merge
  that kept the older snapshot keeps
  its age too: Claude's SDK notifications carry no quota rows, so an empty one neither replaces a
  `/usage` reading nor makes a stale one look freshly observed. A refresh answers with what the
  cache now holds rather than with the snapshot it collected.
- A snapshot names the channel it came from, including when it failed. A failed Claude refresh
  reports `claude_cli_usage`, because that is what ran — not `claude_agent_sdk`, which never went
  quiet, and it carries the `observedAt` of the attempt so a client can tell "asked just now, learned
  nothing" from "never read".
- A refresh that comes back with nothing does not blank a reading that is still inside its normal
  life. The previous windows and account stay, marked `stale` (`refresh_failed` when the attempt
  produced nothing at all, `refresh_empty` when it reached the provider and rendered no rows) with
  the time of the attempt — so the bars a person just asked about survive a transient CLI failure
  without ever being presented as freshly confirmed. The retained reading keeps its original age, so
  a run of failures cannot keep one old panel alive past the 15-minute expiry. A reading that names a
  _different_ account always wins, however empty: one account's bars are never shown under another's
  name.
- Collection is contained per instance (`containedAvailability`). One adapter that fails — or that
  throws, which arrives as a defect and would otherwise bypass typed-error handling and fail the
  whole `forEach` — costs that instance its numbers, never every other instance's card.

**Client compatibility.** `PROVIDER_AVAILABILITY_CONTRACT_VERSION` is the availability vocabulary a
build understands. Version 1 is what already-deployed clients compiled: window kinds were the closed
pair `primary`/`secondary` and `source` was one of `codex_app_server`/`claude_agent_sdk`/
`unsupported`. Those clients decode the RPC result with _their_ schema, so a value outside that
vocabulary does not degrade their Usage page — it fails the whole response, blanking even the
instances they could read. Callers therefore send the version they can decode on
`ProviderAvailabilityInput` (`client-runtime` fills it in for every client), and the server narrows
its answer with `narrowProviderAvailability`: Codex's primary/secondary windows survive untouched,
window kinds and sources an older client has no literal for are dropped, and the status is re-derived
from what survived. Absent means version 1, which is exactly what an old client sends. Bump the
version, and extend the narrowing, whenever a _value_ an older schema would reject is introduced;
purely additive optional _fields_ (`label`, `scope`, `account`, `stale`) need no bump, because struct
decoding ignores keys it does not know.

**Account subjects and MCP.** `ProviderAvailabilityAccount` exists so a person sees one Usage card
per real account; for Claude both its id and display name are the signed-in email address, read from
`claude auth status`. Clients receive it over the RPC the person is already authenticated to.
`list_session_providers` deliberately does not carry it: an agent picks a configured instance, quota
windows are per instance, and MCP output is written to transcripts and reports that other agents
read. Dropping the subject there costs the caller nothing it acts on.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[availability]: ../../packages/contracts/src/providerAvailability.ts
[usageprobe]: ../../apps/server/src/provider/Drivers/ClaudeUsageProbe.ts
[seed]: ../../apps/server/src/provider/conversationSeed.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
