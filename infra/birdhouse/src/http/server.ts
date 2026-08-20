import { serve } from "@hono/node-server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { workflowRun } from "../db/schema.ts";
import { writeAuditEvent } from "../runner/audit.ts";
import { verifyCallbackToken } from "../runner/callbackToken.ts";
import { createWorkflowRun } from "../runner/runs.ts";

export interface OpsHttpServer {
  close: () => Promise<void>;
  /** The actually-bound port (differs from config when a caller passes 0). */
  port: number;
}

const RESULT_STATUSES = ["succeeded", "failed"] as const;
const OPEN_RUN_STATUSES = ["pending", "launching", "running"] as const;

const ResultBodySchema = z.object({
  status: z.enum(RESULT_STATUSES),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const ManualRunBodySchema = z.object({
  input: z.unknown().optional(),
  dedupeKey: z.string().min(1).optional(),
});

function bearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  return match?.[1];
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
    await next();
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

    const parsed = ResultBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const { status, result, error } = parsed.data;

    const [updated] = await db
      .update(workflowRun)
      .set({
        status,
        completedAt: new Date(),
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
  app.post("/api/workflows/:key/run", async (c) => {
    const key = c.req.param("key");
    const parsed = ManualRunBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await createWorkflowRun({
        db,
        workflowKey: key,
        trigger: "api",
        ...(parsed.data.input !== undefined ? { input: parsed.data.input } : {}),
        ...(parsed.data.dedupeKey !== undefined ? { dedupeKey: parsed.data.dedupeKey } : {}),
      });
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "unknown_error" }, 400);
    }
  });

  const boundPort = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolveListen) => {
      const server = serve(
        { fetch: app.fetch, port: deps.port ?? config.BIRDHOUSE_HTTP_PORT, hostname: "127.0.0.1" },
        (info) => resolveListen({ server, port: info.port }),
      );
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
