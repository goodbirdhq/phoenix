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

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

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
  locally. The returned envelope is only accepted when it reports `num_turns: 0` and no cost, so a
  CLI version that ever answered `/usage` with a model turn reads as unknown instead of as free
  quota data. Print mode also skips the interactive workspace-trust dialog, which an interactive PTY
  probe would otherwise answer on the user's behalf.
- **Contained.** The CLI runs in a cache-owned directory with `--safe-mode` (no hooks, MCP servers,
  plugins, or `CLAUDE.md`) and `--no-session-persistence`, under a timeout that kills the child.
- **Strict.** Only rendered quota rows (`Current session: 5% used · resets Aug 18, 1am
(Europe/Berlin)`) become windows, each row's percentage and reset read from that row alone. The
  panel's prose percentages ("75% of your usage was at >150k context") are never windows.
  `testFixtures/claudeUsagePrint.json` is a live capture that pins this.

Reads apply two more rules. Refreshes are claimed atomically per instance under a 30s cooldown, so
two clients clicking at once run the CLI once; and a snapshot older than 15 minutes drops its
windows but keeps its source, observation time, and account, so an account card stays put instead of
flickering away.

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
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[availability]: ../../packages/contracts/src/providerAvailability.ts
[usageprobe]: ../../apps/server/src/provider/Drivers/ClaudeUsageProbe.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
