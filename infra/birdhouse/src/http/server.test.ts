import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workflow } from "../db/schema.ts";
import { startHttpServer } from "./server.ts";

const SKILL_MARKDOWN = "# Claim test skill\n\nDo the claim test thing.\n";

// The HTTP surface is birdhouse's only inbound boundary; the callback route
// is covered end-to-end in runner/lifecycle.test.ts, so these cover the parts
// that route doesn't: the manual trigger, the claim route, and startup itself.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("http server", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let baseUrl: string;
  let tmpDir: string;
  let skillPath: string;

  beforeAll(async () => {
    server = await startHttpServer({ db, port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
    tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "birdhouse-http-skill-"));
    skillPath = NodePath.join(tmpDir, "SKILL.md");
    await NodeFSP.writeFile(skillPath, SKILL_MARKDOWN, "utf8");
  });

  afterAll(async () => {
    await server.close();
    await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    await pool.end();
  });

  /** Inserts a workflow whose skill file is real and readable, for the claim route. */
  async function insertClaimableWorkflow(overrides: { enabled?: boolean } = {}): Promise<string> {
    const key = `test-claim-${NodeCrypto.randomUUID()}`;
    await db.insert(workflow).values({
      key,
      title: "Claimable workflow",
      skillPath,
      manifest: {},
      manifestHash: "test",
      enabled: overrides.enabled ?? true,
    });
    return key;
  }

  it("reports health with database reachability", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("starts a run through the manual trigger", async () => {
    const key = `test-http-${NodeCrypto.randomUUID()}`;
    await db.insert(workflow).values({
      key,
      title: "Manual trigger workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
    });

    const response = await fetch(`${baseUrl}/api/workflows/${key}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { hello: "world" } }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true });
  });

  it("rejects an unknown workflow as not found via /run", async () => {
    const response = await fetch(`${baseUrl}/api/workflows/does-not-exist/run`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_workflow" });
  });

  it("rejects a disabled workflow as a client error via /run", async () => {
    const key = `test-http-disabled-${NodeCrypto.randomUUID()}`;
    await db.insert(workflow).values({
      key,
      title: "Disabled workflow",
      skillPath: "test/SKILL.md",
      manifest: {},
      manifestHash: "test",
      enabled: false,
    });

    const response = await fetch(`${baseUrl}/api/workflows/${key}/run`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "workflow_disabled" });
  });

  it("reports an infrastructure failure as a server error, not a bad request", async () => {
    // A caller told 400 concludes its own request was malformed and stops
    // retrying; a database blip is precisely the case worth retrying.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return () => Promise.reject(new Error("connection terminated unexpectedly"));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const broken = await startHttpServer({ db: brokenDb, port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${broken.port}/api/workflows/whatever/run`, {
        method: "POST",
      });
      expect(response.status).toBe(500);
      // The 500 above is answered by the shared `onError` handler, not a
      // bespoke catch in the route — so it must carry the same JSON {error}
      // contract every other route promises, not Hono's default plain text.
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "internal_error" });
    } finally {
      await broken.close();
    }
  });

  it("keeps the JSON {error} contract on an unhandled failure with no route-level catch", async () => {
    // /api/runs/:id/result has no try/catch of its own; this is the route
    // change 3 exists for. A broken `select` here must still come back as
    // JSON, not fall through to Hono's default plain-text error response.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return () => {
            throw new Error("connection terminated unexpectedly");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const broken = await startHttpServer({ db: brokenDb, port: 0 });
    try {
      const response = await fetch(
        `http://127.0.0.1:${broken.port}/api/runs/${NodeCrypto.randomUUID()}/result`,
        { method: "POST", headers: { authorization: "Bearer whatever" } },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "internal_error" });
    } finally {
      await broken.close();
    }
  });

  // Without an 'error' listener this arrives as an uncaught exception on
  // Node's own stack and takes the worker down, outside any try/catch.
  it("rejects rather than crashing when the port is already taken", async () => {
    await expect(startHttpServer({ db, port: server.port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("keeps the callback URL default in step with the configured port", async () => {
    const { config } = await import("../config.ts");
    expect(config.BIRDHOUSE_PUBLIC_URL).toContain(String(config.BIRDHOUSE_HTTP_PORT));
  });

  it("claims a run and returns instructions carrying the skill body and callback token", async () => {
    const key = await insertClaimableWorkflow();

    const response = await fetch(`${baseUrl}/api/workflows/${key}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { hello: "world" } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runId: string;
      instructions: string;
      callbackUrl: string;
      callbackToken: string;
    };
    const { config } = await import("../config.ts");
    expect(body.runId).toBeTruthy();
    expect(body.callbackToken).toBeTruthy();
    // Built from BIRDHOUSE_PUBLIC_URL, not the port this test server actually
    // bound to (port: 0) — same as the launch handler's callback URL.
    expect(body.callbackUrl).toBe(`${config.BIRDHOUSE_PUBLIC_URL}/api/runs/${body.runId}/result`);
    expect(body.instructions).toContain(SKILL_MARKDOWN.trim());
    expect(body.instructions).toContain(body.callbackToken);
    expect(body.instructions).toContain(body.callbackUrl);
  });

  it("returns 409 while a scheduled run is already open for the workflow", async () => {
    const key = await insertClaimableWorkflow();

    const first = await fetch(`${baseUrl}/api/workflows/${key}/claim`, { method: "POST" });
    expect(first.status).toBe(200);
    const { runId } = (await first.json()) as { runId: string };

    const second = await fetch(`${baseUrl}/api/workflows/${key}/claim`, { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "run_in_progress", runId });
  });

  it("does not let a manual run block a claim, or a claim block a manual run", async () => {
    const key = await insertClaimableWorkflow();

    // An open manual/API run for this workflow must not trip the claim's
    // "one open scheduled run" guard: the partial unique index is scoped to
    // trigger = 'schedule' precisely so these can run in parallel.
    const manualFirst = await fetch(`${baseUrl}/api/workflows/${key}/run`, { method: "POST" });
    expect(manualFirst.status).toBe(201);

    const claim = await fetch(`${baseUrl}/api/workflows/${key}/claim`, { method: "POST" });
    expect(claim.status).toBe(200);

    // Nor does the now-open claimed (scheduled) run block a further manual
    // run of the same workflow.
    const manualSecond = await fetch(`${baseUrl}/api/workflows/${key}/run`, { method: "POST" });
    expect(manualSecond.status).toBe(201);
  });

  it("rejects an unknown workflow as not found via /claim", async () => {
    const response = await fetch(`${baseUrl}/api/workflows/does-not-exist/claim`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_workflow" });
  });

  it("rejects a disabled workflow as a client error via /claim", async () => {
    const key = await insertClaimableWorkflow({ enabled: false });

    const response = await fetch(`${baseUrl}/api/workflows/${key}/claim`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "workflow_disabled" });
  });
});
