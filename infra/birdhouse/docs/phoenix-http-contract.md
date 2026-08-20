# Phoenix HTTP integration contract (verified 2026-08-20 @ origin/main 4f727092)

How the birdhouse starts and observes Phoenix agent threads over plain HTTP.
Verified from source by line-level audit; line refs are to the Phoenix repo.

## Sequence

1. Bootstrap auth (once per ~30 days, same box):
   `phoenix pair --label "birdhouse"` prints a single-use credential (5 min TTL).
   Exchange it: `POST /oauth/token` (form-encoded):
   - grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   - subject_token=<credential>
   - subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
   - requested_token_type=urn:ietf:params:oauth:token-type:access_token
   - scope=orchestration:read orchestration:operate
   - client_label=birdhouse-service
     Response: `{access_token, token_type: "Bearer", expires_in: 2592000, scope}`.
     All calls then use `Authorization: Bearer <token>`.
2. Ensure a project exists (`phoenix project add <path>` or dispatch
   `project.create`). Enumerate via `GET /api/orchestration/snapshot`.
3. Launch = TWO dispatches to `POST /api/orchestration/dispatch`
   (scope `orchestration:operate`; response `{sequence}` only):
   a. `thread.create` — caller-chosen `threadId` (uuid), required `projectId`,
   `title`, `modelSelection: {instanceId, model}`, `runtimeMode`
   ("approval-required"|"auto-accept-edits"|"auto"|"full-access"),
   `branch: null`, `worktreePath: null` (null ⇒ cwd = project workspaceRoot
   — the "project-root" behavior; there is no isolation field at this layer),
   `createdAt` (server overwrites).
   b. `thread.turn.start` — `threadId`, `message: {messageId, role: "user",
text, attachments: []}`, `runtimeMode`, `interactionMode: "default"`,
   `createdAt`. The `bootstrap` field is ACCEPTED BY SCHEMA BUT IGNORED over
   HTTP (only the WS path and spawn_session run ThreadTurnBootstrap), so
   thread.create must be dispatched explicitly first.
4. Observe:
   - `GET /api/orchestration/shell` — cheap poll across all threads:
     `session.status` ("idle"|"starting"|"running"|"ready"|"interrupted"|
     "stopped"|"error"), `latestTurn.state` ("running"|"interrupted"|
     "completed"|"error"), pending-approval/input flags.
   - `GET /api/orchestration/threads/:threadId` — full detail incl.
     `reports: SessionReport[]` (status, title, summary ≤16384 chars, abstract,
     findings[{title,severity,detail}], validation, recommendation,
     completionPercent, usage, origin "agent"|"system"). 404 `thread_not_found`.
   - Push is WS-only (`subscribeThread`/`subscribeShell` after
     `POST /api/auth/websocket-ticket`); polling suffices for the birdhouse.

## Idempotency (server-enforced, commandId-keyed)

- Replaying the same `commandId` on the same aggregate returns the original
  `{sequence}` → reuse the SAME commandId when retrying network failures.
- A command rejected by validation gets a PERMANENT "rejected" receipt →
  after fixing the cause, retry with a FRESH commandId.
- Same commandId on a different aggregate → conflict error.
- Persist commandIds per run before dispatching so crash-retries are safe.

## Errors

Dispatch failures beyond auth/scope/normalization surface only as
500 `{code: "internal_error", reason: "orchestration_dispatch_failed",
traceId}` — detail is server-log-only. 400 invalid_request (normalize),
401 auth_invalid, 403 insufficient_scope `{requiredScope}`.
Undecodable union payloads yield a framework 400 of unverified shape.

## Server

Default `http://127.0.0.1:3873`, loopback bind, plain HTTP, no app-level rate
limit or body cap found. Provider instance/model values are NOT discoverable
over HTTP (WS `server.getConfig` only) — configure via env
(`PHOENIX_PROVIDER_INSTANCE_ID`, `PHOENIX_MODEL`) matching Phoenix settings.

## Notes for the runner

- `thread.report.post` is not dispatchable externally (internal-only command);
  agents post reports themselves via the sessions MCP toolkit. Whether root
  (non-spawned) threads can post reports is UNVERIFIED — treat report
  ingestion as best-effort enrichment; the ops HTTP callback is the primary
  result channel.
- `runtimeMode` for unattended runs: "auto" or "full-access" (approval modes
  would hang headless runs pending a human).
- No unauthenticated bootstrap exists; token renewal is `phoenix pair` +
  `/oauth/token` again. Store the bearer in env/secret file, alert well before
  the 30-day expiry (audit_event + connector-health job).
