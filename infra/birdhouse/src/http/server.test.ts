import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workflow } from "../db/schema.ts";
import { startHttpServer } from "./server.ts";

// The HTTP surface is birdhouse's only inbound boundary; the callback route
// is covered end-to-end in runner/lifecycle.test.ts, so these cover the parts
// that route doesn't: the manual trigger, and startup itself.
describe.skipIf(!process.env.BIRDHOUSE_TEST_DATABASE_URL)("http server", () => {
  const pool = new Pool({ connectionString: process.env.BIRDHOUSE_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startHttpServer({ db, port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("reports health with database reachability", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("starts a run through the manual trigger", async () => {
    const key = `test-http-${randomUUID()}`;
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

  it("rejects an unknown workflow as a client error", async () => {
    const response = await fetch(`${baseUrl}/api/workflows/does-not-exist/run`, {
      method: "POST",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a disabled workflow as a client error", async () => {
    const key = `test-http-disabled-${randomUUID()}`;
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
});
