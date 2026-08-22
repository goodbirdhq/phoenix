#!/usr/bin/env node
import { positionalArgs, readFlag } from "./lib/cliArgs.ts";

const USAGE = `Usage: ops <command>

Commands:
  worker                       Apply pending migrations, then serve the HTTP surface, maintenance loop, and job worker until stopped
  migrate                      Apply pending database migrations
  run <workflow-key> [--input '<json>']
                                Launch one workflow run immediately, printing its run id
  list [--limit N]             List registered workflows and recent runs
  enable <workflow-key>        Enable a workflow so its claims and manual runs fire again
  disable <workflow-key>       Disable a workflow without removing it or its history
  cancel <run-id>              Cancel a queued or in-flight run and stop its agent session
`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padColumns(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_unused, col) =>
    Math.max(...rows.map((row) => (row[col] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

// Deferred, rather than top-level imports: these pull in `db/client.ts`,
// which validates BIRDHOUSE_DATABASE_URL at import time. `run`, `list`, and a bare
// `ops` with no/unknown command must be able to print usage without a
// database configured.
async function runWorker(): Promise<void> {
  const { closeDb, db } = await import("./db/client.ts");
  const { runMigrations } = await import("./db/migrate.ts");
  const { runReadyJobs } = await import("./jobs/queue.ts");
  const { jobHandlerRegistry } = await import("./runner/registry.ts");
  const { startHttpServer } = await import("./http/server.ts");
  const { startMaintenanceLoop } = await import("./maintenance/tick.ts");
  const { resolveWorkflowsDir } = await import("./workflows/loader.ts");
  const { config } = await import("./config.ts");

  await runMigrations();

  const workerId = `birdhouse-worker-${process.pid}-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Fail fast rather than degrade: the callback endpoint is how runs report
  // their results, and its URL is baked into every prompt. A worker that
  // started without it would launch agents whose results go nowhere, and
  // every run would quietly wait out its timeout instead.
  const httpServer = await startHttpServer({ db });

  console.log(JSON.stringify({ event: "worker.started", workerId }));
  try {
    await Promise.all([
      runReadyJobs(db, jobHandlerRegistry, workerId, { signal: controller.signal }),
      startMaintenanceLoop({
        db,
        signal: controller.signal,
        tickMs: config.BIRDHOUSE_MAINTENANCE_TICK_MS,
        workflowsDir: resolveWorkflowsDir(config.BIRDHOUSE_WORKFLOWS_DIR),
      }),
    ]);
  } finally {
    await httpServer.close();
    console.log(JSON.stringify({ event: "worker.stopped", workerId }));
    await closeDb();
  }
}

async function runMigrateCommand(): Promise<void> {
  const { closeDb } = await import("./db/client.ts");
  const { runMigrations } = await import("./db/migrate.ts");
  await runMigrations();
  await closeDb();
}

async function runRunCommand(args: readonly string[]): Promise<void> {
  const [workflowKey] = positionalArgs(args, ["--input"]);
  if (!workflowKey) {
    console.error("Usage: ops run <workflow-key> [--input '<json>']");
    process.exitCode = 1;
    return;
  }

  const inputArg = readFlag(args, "--input");
  let input: unknown;
  if (inputArg !== undefined) {
    try {
      input = JSON.parse(inputArg);
    } catch (error) {
      console.error(`Invalid JSON for --input: ${describeError(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const { closeDb, db } = await import("./db/client.ts");
  const { createWorkflowRun } = await import("./runner/runs.ts");
  try {
    const result = await createWorkflowRun({
      db,
      workflowKey,
      trigger: "manual",
      ...(input !== undefined ? { input } : {}),
    });
    console.log(result.runId);
  } catch (error) {
    console.error(`Failed to start run: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

async function runListCommand(args: readonly string[]): Promise<void> {
  const limitArg = readFlag(args, "--limit");
  const limit = limitArg ? Number(limitArg) : 20;
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("--limit must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const { closeDb, db } = await import("./db/client.ts");
  const { workflow, workflowRun } = await import("./db/schema.ts");
  const { desc } = await import("drizzle-orm");
  try {
    const workflows = await db
      .select({
        key: workflow.key,
        title: workflow.title,
        enabled: workflow.enabled,
      })
      .from(workflow)
      .orderBy(workflow.key);

    const runs = await db
      .select({
        workflowKey: workflowRun.workflowKey,
        status: workflowRun.status,
        trigger: workflowRun.trigger,
        createdAt: workflowRun.createdAt,
        completedAt: workflowRun.completedAt,
      })
      .from(workflowRun)
      .orderBy(desc(workflowRun.createdAt))
      .limit(limit);

    console.log("Workflows:");
    const workflowRows = [
      ["KEY", "TITLE", "ENABLED"],
      ...workflows.map((w) => [w.key, w.title, String(w.enabled)]),
    ];
    for (const line of padColumns(workflowRows)) console.log(`  ${line}`);
    if (workflows.length === 0) console.log("  (none)");

    console.log("");
    console.log(`Recent runs (limit ${limit}):`);
    const runRows = [
      ["WORKFLOW", "STATUS", "TRIGGER", "CREATED", "COMPLETED"],
      ...runs.map((r) => [
        r.workflowKey,
        r.status,
        r.trigger,
        r.createdAt.toISOString(),
        r.completedAt?.toISOString() ?? "-",
      ]),
    ];
    for (const line of padColumns(runRows)) console.log(`  ${line}`);
    if (runs.length === 0) console.log("  (none)");
  } finally {
    await closeDb();
  }
}

/**
 * The way back from a disable. Reconciliation writes `workflow.enabled` when
 * disk stops declaring a workflow, and the sync deliberately never writes it
 * back — so without this, re-enabling meant editing rows by hand.
 */
async function runSetEnabledCommand(args: readonly string[], enabled: boolean): Promise<void> {
  const [workflowKey] = positionalArgs(args, []);
  if (!workflowKey) {
    console.error(`Usage: ops ${enabled ? "enable" : "disable"} <workflow-key>`);
    process.exitCode = 1;
    return;
  }

  const { closeDb, db } = await import("./db/client.ts");
  const { workflow } = await import("./db/schema.ts");
  const { eq } = await import("drizzle-orm");
  const { writeAuditEvent } = await import("./runner/audit.ts");
  try {
    const [updated] = await db
      .update(workflow)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(workflow.key, workflowKey))
      .returning({ key: workflow.key });
    if (!updated) {
      console.error(`Unknown workflow "${workflowKey}"`);
      process.exitCode = 1;
      return;
    }
    await writeAuditEvent(db, {
      actor: "cli",
      action: enabled ? "workflow.enabled" : "workflow.disabled",
      targetType: "workflow",
      targetId: workflowKey,
      outcome: "succeeded",
    });
    console.log(`${workflowKey} ${enabled ? "enabled" : "disabled"}`);
  } finally {
    await closeDb();
  }
}

async function runCancelCommand(args: readonly string[]): Promise<void> {
  const [runId] = positionalArgs(args, []);
  if (!runId) {
    console.error("Usage: ops cancel <run-id>");
    process.exitCode = 1;
    return;
  }

  const { closeDb, db } = await import("./db/client.ts");
  const { cancelWorkflowRun } = await import("./runner/runs.ts");
  try {
    const result = await cancelWorkflowRun(db, runId);
    if (!result.cancelled) {
      console.log(`${runId} already ${result.status}; nothing to cancel`);
    } else if (result.hadPhoenixThread) {
      console.log(`${runId} cancelled (${result.jobsCancelled} job(s) retired)`);
    } else {
      console.log(
        `${runId} marked cancelled; this run has no linked Phoenix thread — stop it in Phoenix if it is still running.`,
      );
    }
  } catch (error) {
    console.error(`Failed to cancel run: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "worker":
      await runWorker();
      return;

    case "migrate":
      await runMigrateCommand();
      return;

    case "run":
      await runRunCommand(args);
      return;

    case "list":
      await runListCommand(args);
      return;

    case "enable":
      await runSetEnabledCommand(args, true);
      return;

    case "disable":
      await runSetEnabledCommand(args, false);
      return;

    case "cancel":
      await runCancelCommand(args);
      return;

    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
      return;
  }
}

await main();
