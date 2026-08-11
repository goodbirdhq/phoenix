# Session Orchestration

How a running agent session spawns and coordinates sibling threads. User-facing behavior:
`docs/user/session-orchestration.md`.

## Shape

The feature rides the existing MCP ingress and the event-sourced command path; no new protocol or
transport. A session calls tools on the per-thread `phoenix` MCP server, the handlers dispatch
ordinary orchestration commands, and the provider adapters do what they always do.

```
agent session ── MCP tool call ──> apps/server/src/mcp/toolkits/sessions/{tools,handlers}.ts
                                      │  requireMcpSessionsCapability + enableSessionOrchestration
                                      ├─ spawn_session ──> ThreadTurnBootstrap.bootstrapTurnStart
                                      │     (thread.create with spawnedByThreadId → worktree →
                                      │      setup script → first turn; rollback on failure)
                                      ├─ send_to_session / read_session / stop_session
                                      └─ post_report ──> thread.report.post (internal command)
                                             │
             thread.report-posted / session error events
                                             │
        SessionSpawnReactor ── thread.turn.start on the spawning thread (the "wake-up")
```

## Pieces

- **Contracts** — `packages/contracts/src/sessionOrchestration.ts` (tool inputs/results, error
  union, spawn caps); `SessionReport`, the `thread.report.post` internal command, the
  `thread.report-posted` event, and `OrchestrationThread.reports` /
  `OrchestrationThreadShell.spawnedByThreadId` live in `orchestration.ts`. All additive: optional
  fields and decoding defaults, so pre-feature clients and payloads keep decoding.
- **Bootstrap service** — `apps/server/src/orchestration/ThreadTurnBootstrap.ts`, the
  create-thread + worktree + setup-script + rollback macro extracted from `ws.ts` so the WS
  dispatch path and the MCP handlers share one implementation.
- **Toolkit** — `apps/server/src/mcp/toolkits/sessions/`. Handlers resolve services once at layer
  build and check the `sessions` capability plus the `enableSessionOrchestration` setting per
  call, so the settings toggle applies to running sessions immediately.
- **Persistence** — migrations 041 (`projection_threads.spawned_by_thread_id`) and 042
  (`projection_thread_reports`), with hydration through `ProjectionPipeline` and
  `ProjectionSnapshotQuery`.
- **Reactor** — `apps/server/src/orchestration/Layers/SessionSpawnReactor.ts` watches
  `thread.report-posted` and `thread.session-set` domain events. A report on a thread with
  `spawnedByThreadId` starts a turn on the parent carrying the report; a provider error notifies
  once per error episode (re-armed when the session recovers). Turn injection is the wake
  mechanism deliberately: no held-open tool calls, survives restarts, works over remote/tunnel.

## Guardrails

- Mutating tools operate only on direct children of the calling thread.
- At most `SESSION_SPAWN_MAX_CHILDREN` (8) live children per thread and
  `SESSION_SPAWN_MAX_DEPTH` (3) levels of nesting.
- A child's `runtimeMode` is capped at its parent's.
- Spawned threads participate in normal archive/settle session cleanup, so orchestration cannot
  leak provider processes.

## Gotcha worth remembering

Every MCP tool here must declare at least one (optional) parameter. An empty `Schema.Struct({})`
encodes to a typeless `anyOf` JSON schema, and Claude Code drops an MCP server's entire toolset
when any single tool schema fails its validation — while still reporting the server as connected.
