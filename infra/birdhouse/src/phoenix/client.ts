import type { OpsConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// Wire types
//
// Deliberately hand-rolled rather than imported from `@t3tools/contracts`:
// this package has no workspace dependencies by design (see README "Layout"),
// so it can be extended for years independent of the rest of the monorepo.
// Every shape below was verified against packages/contracts/src/orchestration.ts
// and apps/server/src/orchestration/http.ts in this worktree (see
// docs/phoenix-http-contract.md for the line-level audit) and trimmed to only
// the fields the birdhouse reads or writes.
// ---------------------------------------------------------------------------

export type PhoenixRuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** Only "default" is ever sent by the birdhouse; "plan" exists for interactive UI use. */
export type PhoenixInteractionMode = "default" | "plan";

export interface PhoenixModelSelection {
  instanceId: string;
  model: string;
}

/**
 * `thread.create` — see docs/phoenix-http-contract.md §Sequence step 3a.
 * `worktreePath`/`branch` are always null: the birdhouse launches root
 * (project-root) threads, never worktree-isolated ones.
 */
export interface ThreadCreateCommand {
  type: "thread.create";
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  modelSelection: PhoenixModelSelection;
  runtimeMode: PhoenixRuntimeMode;
  interactionMode: PhoenixInteractionMode;
  branch: null;
  worktreePath: null;
  createdAt: string;
}

/**
 * `thread.turn.start` — see docs/phoenix-http-contract.md §Sequence step 3b.
 * `bootstrap` is intentionally never sent: it is accepted by schema but
 * ignored over HTTP, so `thread.create` must already have run.
 */
export interface ThreadTurnStartCommand {
  type: "thread.turn.start";
  commandId: string;
  threadId: string;
  message: {
    messageId: string;
    role: "user";
    text: string;
    attachments: [];
  };
  runtimeMode: PhoenixRuntimeMode;
  interactionMode: PhoenixInteractionMode;
  createdAt: string;
}

export type PhoenixSessionStopReason =
  | "user_stopped"
  | "parent_stopped"
  | "permission_denied"
  | "tool_failed"
  | "provider_crashed";

export type PhoenixSessionStoppedBy = "user" | "parent" | "system";

/**
 * `thread.session.stop` — fields verified against
 * packages/contracts/src/orchestration.ts `ThreadSessionStopCommand` (all
 * beyond type/commandId/threadId/createdAt are optional on the wire).
 */
export interface ThreadSessionStopCommand {
  type: "thread.session.stop";
  commandId: string;
  threadId: string;
  createdAt: string;
  stopReason?: PhoenixSessionStopReason;
  stoppedBy?: PhoenixSessionStoppedBy;
}

export type PhoenixOrchestrationCommand =
  | ThreadCreateCommand
  | ThreadTurnStartCommand
  | ThreadSessionStopCommand;

export interface PhoenixDispatchResult {
  sequence: number;
}

export type PhoenixSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export type PhoenixTurnState = "running" | "interrupted" | "completed" | "error";

/** GET /api/orchestration/shell — one entry per thread, shell-weight only. */
export interface PhoenixShellThread {
  id: string;
  session: { status: PhoenixSessionStatus } | null;
  latestTurn: { state: PhoenixTurnState } | null;
}

export interface PhoenixShellSnapshot {
  threads: PhoenixShellThread[];
}

export type PhoenixSessionReportStatus = "success" | "failure" | "partial";

/** A subset of SessionReport — only what the watch handler ingests. */
export interface PhoenixSessionReport {
  reportId: string;
  status: PhoenixSessionReportStatus;
  title: string;
  summary: string;
  origin: "agent" | "system";
}

/** GET /api/orchestration/threads/:threadId — full detail, trimmed to what we read. */
export interface PhoenixThreadDetail {
  id: string;
  session: { status: PhoenixSessionStatus } | null;
  latestTurn: { state: PhoenixTurnState } | null;
  reports: PhoenixSessionReport[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PhoenixClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PhoenixClientError";
  }
}

/** 401 auth_invalid / 403 insufficient_scope, or a locally-detected missing token. */
export class PhoenixAuthError extends PhoenixClientError {
  readonly status: number;
  readonly reason?: string;
  readonly requiredScope?: string;
  readonly traceId?: string;

  constructor(input: {
    status: number;
    reason?: string;
    requiredScope?: string;
    traceId?: string;
  }) {
    super(
      `Phoenix auth error (${input.status})${input.reason ? `: ${input.reason}` : ""}${
        input.requiredScope ? ` (requires scope "${input.requiredScope}")` : ""
      }`,
    );
    this.name = "PhoenixAuthError";
    this.status = input.status;
    if (input.reason !== undefined) this.reason = input.reason;
    if (input.requiredScope !== undefined) this.requiredScope = input.requiredScope;
    if (input.traceId !== undefined) this.traceId = input.traceId;
  }
}

/** 400 invalid_request: the command was rejected before dispatch. Per the
 * contract's idempotency rules, retrying this exact commandId is permanently
 * rejected — callers must mint a fresh commandId after fixing the cause. */
export class PhoenixInvalidRequestError extends PhoenixClientError {
  readonly reason?: string;
  readonly traceId?: string;

  constructor(input: { reason?: string; traceId?: string }) {
    super(`Phoenix rejected the request as invalid${input.reason ? `: ${input.reason}` : ""}`);
    this.name = "PhoenixInvalidRequestError";
    if (input.reason !== undefined) this.reason = input.reason;
    if (input.traceId !== undefined) this.traceId = input.traceId;
  }
}

/** 500 {code: "internal_error", reason: "orchestration_dispatch_failed", traceId}. */
export class PhoenixDispatchFailedError extends PhoenixClientError {
  readonly traceId?: string;

  constructor(input: { traceId?: string }) {
    super(
      `Phoenix orchestration dispatch failed (server-log-only detail; traceId=${input.traceId ?? "unknown"})`,
    );
    this.name = "PhoenixDispatchFailedError";
    if (input.traceId !== undefined) this.traceId = input.traceId;
  }
}

/**
 * The Phoenix box could not be reached at all (connection refused, DNS
 * failure, timeout) or returned a response the client could not parse as
 * JSON. Distinct from the typed API errors above because it says nothing
 * about whether the command was applied — callers should treat it as
 * "unknown outcome, safe to retry with the same commandId", and job handlers
 * attach `retryAfterMs` so retries don't burn the attempt budget.
 */
export class PhoenixUnreachableError extends PhoenixClientError {
  readonly retryAfterMs = 60_000;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PhoenixUnreachableError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PhoenixClientCallOptions {
  signal?: AbortSignal;
}

/**
 * Typed client over Phoenix's orchestration HTTP API. `createThread` and
 * `startTurn` are pure builders — they hand back the exact command payload
 * without dispatching it, so a caller can persist the chosen
 * commandId/threadId/messageId to its own durable store *before* calling
 * `dispatch`, which is what makes a crash between "build" and "dispatch"
 * safe to retry with the same ids (contract §Idempotency).
 */
export interface PhoenixClient {
  dispatch(
    command: PhoenixOrchestrationCommand,
    options?: PhoenixClientCallOptions,
  ): Promise<PhoenixDispatchResult>;

  createThread(input: {
    commandId: string;
    threadId: string;
    projectId: string;
    title: string;
    modelSelection: PhoenixModelSelection;
    runtimeMode: PhoenixRuntimeMode;
  }): ThreadCreateCommand;

  startTurn(input: {
    commandId: string;
    threadId: string;
    messageId: string;
    text: string;
    runtimeMode: PhoenixRuntimeMode;
  }): ThreadTurnStartCommand;

  /**
   * Best-effort `thread.session.stop`. Mints its own commandId (callers have
   * no retry state to key on for a fire-and-forget stop) and never throws —
   * a failed stop just means the session keeps running until Phoenix's own
   * idle/error handling catches up; it must never fail the caller's job.
   */
  stopSession(
    threadId: string,
    input?: { stopReason?: PhoenixSessionStopReason; stoppedBy?: PhoenixSessionStoppedBy },
    options?: PhoenixClientCallOptions,
  ): Promise<void>;

  getShell(options?: PhoenixClientCallOptions): Promise<PhoenixShellSnapshot>;

  getThread(threadId: string, options?: PhoenixClientCallOptions): Promise<PhoenixThreadDetail>;
}

function randomId(): string {
  return crypto.randomUUID();
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isErrorBody(
  body: unknown,
): body is { code?: string; reason?: string; requiredScope?: string; traceId?: string } {
  return typeof body === "object" && body !== null;
}

export function createPhoenixClient(
  config: Pick<OpsConfig, "PHOENIX_BASE_URL" | "PHOENIX_BIRDHOUSE_TOKEN">,
): PhoenixClient {
  const baseUrl = config.PHOENIX_BASE_URL.replace(/\/+$/, "");

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    // Fail fast, client-side, rather than firing a request known to come
    // back 401: every call site must treat an unset token as unauthenticated
    // (see src/config.ts), and this avoids a wasted round trip plus a less
    // specific error for the common "not configured yet" case.
    if (!config.PHOENIX_BIRDHOUSE_TOKEN) {
      throw new PhoenixAuthError({ status: 401, reason: "ops_token_not_configured" });
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.PHOENIX_BIRDHOUSE_TOKEN}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new PhoenixUnreachableError(
        `Could not reach Phoenix at ${baseUrl}${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (response.ok) {
      const body = await parseJsonSafely(response);
      if (body === undefined) {
        throw new PhoenixUnreachableError(
          `Phoenix returned a ${response.status} with an unparseable/empty body from ${path}`,
        );
      }
      return body;
    }

    const body = await parseJsonSafely(response);
    const errorBody = isErrorBody(body) ? body : {};
    const traceId = typeof errorBody.traceId === "string" ? errorBody.traceId : undefined;
    const reason = typeof errorBody.reason === "string" ? errorBody.reason : undefined;

    if (response.status === 401) {
      throw new PhoenixAuthError({
        status: 401,
        ...(reason ? { reason } : {}),
        ...(traceId ? { traceId } : {}),
      });
    }
    if (response.status === 403) {
      const requiredScope =
        typeof errorBody.requiredScope === "string" ? errorBody.requiredScope : undefined;
      throw new PhoenixAuthError({
        status: 403,
        ...(reason ? { reason } : {}),
        ...(requiredScope ? { requiredScope } : {}),
        ...(traceId ? { traceId } : {}),
      });
    }
    if (response.status === 400) {
      throw new PhoenixInvalidRequestError({
        ...(reason ? { reason } : {}),
        ...(traceId ? { traceId } : {}),
      });
    }
    if (response.status === 500) {
      throw new PhoenixDispatchFailedError({ ...(traceId ? { traceId } : {}) });
    }
    // Any other status (404 thread_not_found, framework 400s on undecodable
    // unions, etc.) — surface generically; callers that care about a
    // specific one (404 on getThread) check response shape themselves.
    throw new PhoenixClientError(
      `Phoenix returned an unexpected ${response.status} from ${path}${reason ? `: ${reason}` : ""}`,
    );
  }

  return {
    async dispatch(command, options) {
      const body = await request("/api/orchestration/dispatch", {
        method: "POST",
        body: command,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const sequence = (body as { sequence?: unknown } | undefined)?.sequence;
      if (typeof sequence !== "number") {
        throw new PhoenixUnreachableError(
          `Phoenix dispatch response was missing a numeric "sequence" field: ${JSON.stringify(body)}`,
        );
      }
      return { sequence };
    },

    createThread(input) {
      return {
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      };
    },

    startTurn(input) {
      return {
        type: "thread.turn.start",
        commandId: input.commandId,
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: input.text,
          attachments: [],
        },
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      };
    },

    async stopSession(threadId, input, options) {
      const command: ThreadSessionStopCommand = {
        type: "thread.session.stop",
        commandId: randomId(),
        threadId,
        createdAt: new Date().toISOString(),
        ...(input?.stopReason ? { stopReason: input.stopReason } : {}),
        ...(input?.stoppedBy ? { stoppedBy: input.stoppedBy } : {}),
      };
      try {
        await request("/api/orchestration/dispatch", {
          method: "POST",
          body: command,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // Best-effort: a stop that fails to land leaves the session running
        // until Phoenix's own lifecycle handling reaps it. Never propagate.
        if (error instanceof DOMException && error.name === "AbortError") throw error;
      }
    },

    async getShell(options) {
      const body = await request("/api/orchestration/shell", {
        method: "GET",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const threads = (body as { threads?: unknown } | undefined)?.threads;
      return { threads: Array.isArray(threads) ? (threads as PhoenixShellThread[]) : [] };
    },

    async getThread(threadId, options) {
      const body = await request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
        method: "GET",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const thread = (body as { thread?: unknown } | undefined)?.thread;
      if (typeof thread !== "object" || thread === null) {
        throw new PhoenixUnreachableError(
          `Phoenix thread detail response for ${threadId} was missing a "thread" object`,
        );
      }
      const t = thread as Partial<PhoenixThreadDetail>;
      return {
        id: typeof t.id === "string" ? t.id : threadId,
        session: t.session ?? null,
        latestTurn: t.latestTurn ?? null,
        reports: Array.isArray(t.reports) ? t.reports : [],
      };
    },
  };
}
