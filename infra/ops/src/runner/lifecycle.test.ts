import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { opsJob, workflow, workflowRun } from "../db/schema.ts";
import type { OpsJobRow } from "../jobs/types.ts";
import type {
  PhoenixClient,
  PhoenixOrchestrationCommand,
  PhoenixSessionReport,
  PhoenixThreadDetail,
} from "../phoenix/client.ts";
import { startHttpServer } from "../http/server.ts";
import { createWorkflowLaunchHandler, createWorkflowWatchHandler } from "./handlers.ts";
import { deriveRunPhoenixIds } from "./ids.ts";
import { createWorkflowRun } from "./runs.ts";

// Exercises the whole run lifecycle against a real Postgres: the durable
// job queue, the launch/watch handlers, and the HTTP callback route all
// interact through actual row updates and guarded WHERE clauses that a mock
// database can't represent faithfully (see queue.test.ts for the same
// rationale on the job queue alone). A fake PhoenixClient stands in for the
// network boundary Phoenix itself owns.
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)("workflow run lifecycle", () => {
  const pool = new Pool({ connectionString: process.env.OPS_TEST_DATABASE_URL });
  const db = drizzle({ client: pool });
  let skillPath: string;
  let tmpDir: string;
  let httpServer: Awaited<ReturnType<typeof startHttpServer>>;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ops-hub-skill-"));
    skillPath = join(tmpDir, "SKILL.md");
    await writeFile(skillPath, "# Test skill\n\nDo the test thing.\n", "utf8");
    httpServer = await startHttpServer({ db, port: 0 });
  });

  afterAll(async () => {
    await httpServer.close();
    await rm(tmpDir, { recursive: true, force: true });
    await pool.end();
  });

  function fakePhoenixClient() {
    const state = {
      dispatches: [] as PhoenixOrchestrationCommand[],
      stopCalls: [] as string[],
      sequence: 0,
      threadDetail: {
        id: "",
        session: { status: "running" },
        latestTurn: { state: "running" },
        reports: [] as PhoenixSessionReport[],
      } as PhoenixThreadDetail,
    };
    const client: PhoenixClient = {
      async dispatch(command) {
        state.dispatches.push(command);
        state.sequence += 1;
        return { sequence: state.sequence };
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
          message: { messageId: input.messageId, role: "user", text: input.text, attachments: [] },
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        };
      },
      async stopSession(threadId) {
        state.stopCalls.push(threadId);
      },
      async getShell() {
        return { threads: [] };
      },
      async getThread(threadId) {
        return { ...state.threadDetail, id: threadId };
      },
    };
    return { client, state };
  }

  async function insertWorkflow(input: {
    key: string;
    mode: "shadow" | "live";
    timeoutMs?: number;
  }) {
    await db.insert(workflow).values({
      key: input.key,
      title: `Test workflow ${input.key}`,
      skillPath,
      manifest: input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {},
      manifestHash: "test",
      mode: input.mode,
      enabled: true,
    });
  }

  function fakeLease(job: OpsJobRow) {
    return {
      jobId: job.id,
      workerId: "test-worker",
      leaseVersion: job.leaseVersion,
      leaseMs: 60_000,
      leaseLostSignal: new AbortController().signal,
    };
  }

  async function jobByIdempotencyKey(idempotencyKey: string) {
    const [job] = await db
      .select()
      .from(opsJob)
      .where(eq(opsJob.idempotencyKey, idempotencyKey))
      .limit(1);
    return job;
  }

  it("runs the happy path: create -> launch -> callback completes -> watch no-ops", async () => {
    const workflowKey = `test-happy-${randomUUID()}`;
    await insertWorkflow({ key: workflowKey, mode: "shadow" });
    const { client, state } = fakePhoenixClient();
    const launchHandler = createWorkflowLaunchHandler({ db, phoenixClient: client });
    const watchHandler = createWorkflowWatchHandler({ db, phoenixClient: client });

    const created = await createWorkflowRun({
      db,
      workflowKey,
      trigger: "manual",
      input: { hello: "world" },
    });
    expect(created.created).toBe(true);
    const { runId } = created;

    const launchJob = await jobByIdempotencyKey(`run:${runId}`);
    expect(launchJob).toBeDefined();
    const rawCallbackToken = (launchJob!.payload as { callbackToken: string }).callbackToken;
    expect(rawCallbackToken).toBeTruthy();

    await launchHandler.handle(launchJob!, fakeLease(launchJob!));

    const ids = deriveRunPhoenixIds(runId);
    expect(state.dispatches.map((d) => d.type)).toEqual(["thread.create", "thread.turn.start"]);
    expect(state.dispatches[0]).toMatchObject({
      commandId: ids.createCommandId,
      threadId: ids.threadId,
    });
    expect(state.dispatches[1]).toMatchObject({
      commandId: ids.turnCommandId,
      threadId: ids.threadId,
    });

    const [running] = await db.select().from(workflowRun).where(eq(workflowRun.id, runId)).limit(1);
    expect(running?.status).toBe("running");
    expect(running?.phoenixThreadId).toBe(ids.threadId);
    expect(running?.timeoutAt).not.toBeNull();

    const watchJob = await jobByIdempotencyKey(`watch:${runId}:1`);
    expect(watchJob).toBeDefined();

    // The agent calling back, over real HTTP.
    const response = await fetch(`http://127.0.0.1:${httpServer.port}/api/runs/${runId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawCallbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "succeeded", result: { ok: true } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [completed] = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, runId))
      .limit(1);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result).toEqual({ ok: true });
    expect(completed?.completedAt).not.toBeNull();

    // A replay with the same token is idempotent, not an error.
    const replay = await fetch(`http://127.0.0.1:${httpServer.port}/api/runs/${runId}/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawCallbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "succeeded", result: { ok: true } }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ alreadyComplete: true });

    // The watch job, arriving after the callback already completed the run,
    // must no-op rather than re-complete or reschedule.
    const watchResult = await watchHandler.handle(watchJob!, fakeLease(watchJob!));
    expect(watchResult).toEqual({ alreadyTerminal: "succeeded" });
    expect(await jobByIdempotencyKey(`watch:${runId}:2`)).toBeUndefined();
  });

  it("rejects a callback with the wrong token", async () => {
    const workflowKey = `test-badtoken-${randomUUID()}`;
    await insertWorkflow({ key: workflowKey, mode: "shadow" });
    const { client } = fakePhoenixClient();
    const launchHandler = createWorkflowLaunchHandler({ db, phoenixClient: client });

    const created = await createWorkflowRun({ db, workflowKey, trigger: "manual" });
    const launchJob = await jobByIdempotencyKey(`run:${created.runId}`);
    await launchHandler.handle(launchJob!, fakeLease(launchJob!));

    const response = await fetch(
      `http://127.0.0.1:${httpServer.port}/api/runs/${created.runId}/result`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer not-the-right-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "succeeded" }),
      },
    );
    expect(response.status).toBe(401);

    const [run] = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, created.runId))
      .limit(1);
    expect(run?.status).toBe("running");
  });

  it("completes a run from a terminal report when the callback never arrives", async () => {
    const workflowKey = `test-report-${randomUUID()}`;
    await insertWorkflow({ key: workflowKey, mode: "live" });
    const { client, state } = fakePhoenixClient();
    const launchHandler = createWorkflowLaunchHandler({ db, phoenixClient: client });
    const watchHandler = createWorkflowWatchHandler({ db, phoenixClient: client });

    const created = await createWorkflowRun({ db, workflowKey, trigger: "manual" });
    const launchJob = await jobByIdempotencyKey(`run:${created.runId}`);
    await launchHandler.handle(launchJob!, fakeLease(launchJob!));
    const watchJob = await jobByIdempotencyKey(`watch:${created.runId}:1`);

    state.threadDetail = {
      ...state.threadDetail,
      reports: [
        {
          reportId: "report-1",
          status: "success",
          title: "All done",
          summary: "Everything worked.",
          origin: "agent",
        },
      ],
    };

    const result = await watchHandler.handle(watchJob!, fakeLease(watchJob!));
    expect(result).toEqual({ completedVia: "report" });

    const [run] = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, created.runId))
      .limit(1);
    expect(run?.status).toBe("succeeded");
    expect((run?.result as { completedVia?: string } | null)?.completedVia).toBe("report");
  });

  it("times a run out once timeout_at has passed, and stops the session", async () => {
    const workflowKey = `test-timeout-${randomUUID()}`;
    // A negative-ish timeout (1ms) so it's already in the past by the time
    // the watch handler runs.
    await insertWorkflow({ key: workflowKey, mode: "live", timeoutMs: 1 });
    const { client, state } = fakePhoenixClient();
    const launchHandler = createWorkflowLaunchHandler({ db, phoenixClient: client });
    const watchHandler = createWorkflowWatchHandler({ db, phoenixClient: client });

    const created = await createWorkflowRun({ db, workflowKey, trigger: "manual" });
    const launchJob = await jobByIdempotencyKey(`run:${created.runId}`);
    await launchHandler.handle(launchJob!, fakeLease(launchJob!));
    const watchJob = await jobByIdempotencyKey(`watch:${created.runId}:1`);

    // Give the 1ms timeout time to elapse relative to the DB clock.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await watchHandler.handle(watchJob!, fakeLease(watchJob!));
    expect(result).toEqual({ timedOut: true });

    const [run] = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, created.runId))
      .limit(1);
    expect(run?.status).toBe("timed_out");
    expect(state.stopCalls).toContain(deriveRunPhoenixIds(created.runId).threadId);
  });
});
