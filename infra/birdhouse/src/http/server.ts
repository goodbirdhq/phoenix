import { serve } from "@hono/node-server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { OPEN_RUN_STATUSES, workflowRun } from "../db/schema.ts";
import { writeAuditEvent } from "../runner/audit.ts";
import { verifyCallbackToken } from "../runner/callbackToken.ts";
import { buildRunPrompt } from "../runner/prompt.ts";
import {
  claimWorkflowRun,
  createWorkflowRun,
  isWorkflowLookupError,
  type WorkflowLookupErrorReason,
} from "../runner/runs.ts";
import { loadSkillMarkdown } from "../workflows/skill.ts";

export interface OpsHttpServer {
  close: () => Promise<void>;
  /** The actually-bound port (differs from config when a caller passes 0). */
  port: number;
}

const RESULT_STATUSES = ["succeeded", "failed"] as const;

const ResultBodySchema = z.object({
  status: z.enum(RESULT_STATUSES),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const ManualRunBodySchema = z.object({
  input: z.unknown().optional(),
  dedupeKey: z.string().min(1).optional(),
});

const ClaimBodySchema = z.object({
  input: z.unknown().optional(),
});

function bearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  return match?.[1];
}

/** `/run` and `/claim` both classify `WorkflowLookupError` this way; kept in one place so they can't drift apart again. */
function workflowLookupErrorStatus(reason: WorkflowLookupErrorReason): 404 | 400 {
  return reason === "unknown_workflow" ? 404 : 400;
}

/**
 * Parses and validates a JSON body, returning either the typed data or the
 * 400 response to send as-is. An absent or unparseable body is treated as
 * `{}`: the all-optional bodies then validate, so a caller may POST nothing
 * at all, and the result callback still rejects it for want of `status`.
 */
async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: "invalid_body", issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Start the birdhouse HTTP surface (run-result callback, health, manual
 * trigger). Binds loopback-only per `BIRDHOUSE_HTTP_PORT` — see the comment on the
 * manual-trigger route below for what that assumption buys us.
 */
export async function startHttpServer(deps: { db: Db; port?: number }): Promise<OpsHttpServer> {
  const { db } = deps;
  const app = new Hono();

  // One structured line per request; birdhouse logs are read as JSON, not
  // grepped as text, so every log emitter in this package uses this shape.
  app.use("*", async (c, next) => {
    const start = Date.now();
    try {
      await next();
    } catch (thrown) {
      // Hono hands `onError` only what is `instanceof Error` and rethrows
      // anything else past it, where the node adapter answers an empty 500
      // with no body and nothing logged. Deleting the routes' own catch
      // blocks removed the blanket net that used to cover that, so restore
      // it once, here, rather than per route.
      throw thrown instanceof Error ? thrown : new Error(String(thrown));
    }
    console.log(
      JSON.stringify({
        event: "http.request",
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      }),
    );
  });

  // Registered before every route: the shared landing spot for anything a
  // route didn't classify itself (a Postgres blip, a bug), so this is the
  // one place, not every handler, that has to keep `/api/runs/:id/result` —
  // the busiest route in the service, with no try/catch of its own — inside
  // the JSON {error} contract every other route promises. Hono's own default
  // handler answers plain text, which would silently break that contract.
  // Both entry points can be handed a workflow key that does not resolve and
  // answer that identically, so they let it propagate here rather than
  // repeating the mapping. Anything unclassified stays a 500: calling infra
  // trouble a 4xx tells a client its request was malformed, so it gives up
  // instead of retrying something that would have worked a moment later.
  app.onError((err, c) => {
    if (isWorkflowLookupError(err)) {
      return c.json({ error: err.reason }, workflowLookupErrorStatus(err.reason));
    }
    console.error(
      JSON.stringify({
        event: "http.unhandled_error",
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/health", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true, db: true });
    } catch {
      return c.json({ ok: false, db: false }, 503);
    }
  });

  app.post("/api/runs/:id/result", async (c) => {
    const runId = c.req.param("id");
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "missing_token" }, 401);
    }

    const [run] = await db.select().from(workflowRun).where(eq(workflowRun.id, runId)).limit(1);
    if (!run) {
      return c.json({ error: "not_found" }, 404);
    }
    if (!run.callbackTokenHash || !verifyCallbackToken(token, run.callbackTokenHash)) {
      return c.json({ error: "invalid_token" }, 401);
    }

    // A valid token replayed against a run that already reached a terminal
    // state (by this callback, or by the watch job's report/timeout paths)
    // is a legitimate retry from the agent's side, not an error.
    if (!(OPEN_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return c.json({ alreadyComplete: true });
    }

    const parsed = await parseJsonBody(c, ResultBodySchema);
    if (!parsed.ok) return parsed.response;
    const { status, result, error } = parsed.data;

    const [updated] = await db
      .update(workflowRun)
      .set({
        status,
        completedAt: sql`now()`,
        result: (result ?? null) as Record<string, unknown> | null,
        error: error ?? null,
      })
      .where(and(eq(workflowRun.id, runId), inArray(workflowRun.status, [...OPEN_RUN_STATUSES])))
      .returning();

    if (!updated) {
      // Lost the race to the watch job completing the run first.
      return c.json({ alreadyComplete: true });
    }

    await writeAuditEvent(db, {
      actor: "phoenix-callback",
      action: "run.completed",
      targetType: "workflow_run",
      targetId: runId,
      outcome: status === "succeeded" ? "succeeded" : "failed",
      metadata: { completedVia: "callback" },
    });

    return c.json({ ok: true });
  });

  // No auth beyond loopback binding: this is a same-box manual trigger for
  // v1, meant to be called from the CLI/a local script, not the network.
  // Exposing BIRDHOUSE_HTTP_PORT beyond 127.0.0.1 requires adding real auth to
  // this route first — see README before changing the bind address.
  // An unresolvable workflow key throws from the run helpers and becomes a
  // 404/400 in `app.onError` above; this handler only writes success.
  app.post("/api/workflows/:key/run", async (c) => {
    const key = c.req.param("key");
    const parsed = await parseJsonBody(c, ManualRunBodySchema);
    if (!parsed.ok) return parsed.response;
    const result = await createWorkflowRun({
      db,
      workflowKey: key,
      trigger: "api",
      ...(parsed.data.input !== undefined ? { input: parsed.data.input } : {}),
      ...(parsed.data.dedupeKey !== undefined ? { dedupeKey: parsed.data.dedupeKey } : {}),
    });
    return c.json(result, result.created ? 201 : 200);
  });

  // Same loopback trust model as /run above, and no auth beyond it: this is
  // how a Phoenix Schedule's thread collects its run assignment. It hands
  // out live instructions (including a per-run callback bearer token) to
  // whoever asks for a given workflow key, which is only safe because
  // nothing but this box can reach it — see the comment on /run before
  // changing the bind address.
  // An unresolvable workflow key throws from the run helpers and becomes a
  // 404/400 in `app.onError` above; this handler only writes success.
  app.post("/api/workflows/:key/claim", async (c) => {
    const key = c.req.param("key");
    const parsed = await parseJsonBody(c, ClaimBodySchema);
    if (!parsed.ok) return parsed.response;

    const claim = await claimWorkflowRun({
      db,
      workflowKey: key,
      ...(parsed.data.input !== undefined ? { input: parsed.data.input } : {}),
    });

    if (claim.status === "busy") {
      return c.json({ error: "run_in_progress", runId: claim.runId }, 409);
    }

    // Built from the snapshot the claim recorded, not a fresh read: the mode
    // these instructions describe must be the mode the run row was written
    // under, even if an operator flips the workflow in between.
    const skillMarkdown = await loadSkillMarkdown(claim.workflow.skillPath);
    const callbackUrl = `${config.BIRDHOUSE_PUBLIC_URL.replace(/\/+$/, "")}/api/runs/${claim.runId}/result`;
    const instructions = buildRunPrompt({
      workflow: { key: claim.workflow.key, title: claim.workflow.title },
      run: { id: claim.runId, mode: claim.workflow.mode, input: parsed.data.input ?? null },
      skillMarkdown,
      callbackUrl,
      callbackToken: claim.callbackToken,
    });

    return c.json({
      runId: claim.runId,
      instructions,
      callbackUrl,
      callbackToken: claim.callbackToken,
    });
  });

  const boundPort = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolveListen, rejectListen) => {
      const server = serve(
        { fetch: app.fetch, port: deps.port ?? config.BIRDHOUSE_HTTP_PORT, hostname: "127.0.0.1" },
        (info) => {
          // Startup is over: hand the socket's errors to a logger so a later
          // one is reported rather than taking the process down, and so the
          // listener below can't reject an already-settled promise.
          server.removeListener("error", rejectListen);
          server.on("error", (error: Error) => {
            console.error(JSON.stringify({ event: "http.server_error", error: error.message }));
          });
          resolveListen({ server, port: info.port });
        },
      );
      // A bind failure (EADDRINUSE on a shared box) arrives as an 'error'
      // event on the next tick, not as a throw from serve(). With no listener
      // Node re-raises it as an uncaught exception on its own stack, outside
      // any caller's try/catch — so the worker died on a port conflict while
      // the code that meant to handle that never ran.
      server.once("error", rejectListen);
    },
  );

  return {
    port: boundPort.port,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        boundPort.server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}
