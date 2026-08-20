#!/usr/bin/env node
const USAGE = `Usage: ops <command>

Commands:
  worker                       Apply pending migrations, then serve the HTTP surface, scheduler, and job worker until stopped
  migrate                      Apply pending database migrations
  run <workflow-key> [--input '<json>']
                                Launch one workflow run immediately, printing its run id
  list [--limit N]             List registered workflows (with next schedule occurrences) and recent runs
`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Value of a `--flag value` pair, or undefined if the flag isn't present. */
function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** Positional args only — everything but a known `--flag value` pair. */
function positionalArgs(args: readonly string[], flags: readonly string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== undefined && flags.includes(arg)) {
      i += 1; // skip its value
      continue;
    }
    if (arg !== undefined) positional.push(arg);
  }
  return positional;
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
// which validates OPS_DATABASE_URL at import time. `run`, `list`, and a bare
// `ops` with no/unknown command must be able to print usage without a
// database configured.
async function runWorker(): Promise<void> {
  const { closeDb, db } = await import("./db/client.ts");
  const { runMigrations } = await import("./db/migrate.ts");
  const { runReadyJobs } = await import("./jobs/queue.ts");
  const { jobHandlerRegistry } = await import("./runner/registry.ts");
  const { startHttpServer } = await import("./http/server.ts");
  const { startSchedulerLoop } = await import("./scheduler/tick.ts");
  const { resolveWorkflowsDir } = await import("./workflows/loader.ts");
  const { config } = await import("./config.ts");

  await runMigrations();

  const workerId = `ops-worker-${process.pid}-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // The HTTP wave (callback endpoint, health, manual trigger) lands
  // separately from this one; until it does, `startHttpServer` throws.
  // Tolerate that so the scheduler and job worker still run standalone.
  let httpServer: { close: () => Promise<void> } | undefined;
  try {
    httpServer = await startHttpServer({ db });
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "worker.http_server_unavailable", error: describeError(error) }),
    );
  }

  console.log(JSON.stringify({ event: "worker.started", workerId }));
  try {
    await Promise.all([
      runReadyJobs(db, jobHandlerRegistry, workerId, { signal: controller.signal }),
      startSchedulerLoop({
        db,
        signal: controller.signal,
        tickMs: config.OPS_SCHEDULER_TICK_MS,
        workflowsDir: resolveWorkflowsDir(config.OPS_WORKFLOWS_DIR),
        defaultTimezone: config.OPS_TIMEZONE,
      }),
    ]);
  } finally {
    if (httpServer) await httpServer.close();
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
  const { workflow, workflowRun, workflowSchedule } = await import("./db/schema.ts");
  const { desc, eq, min } = await import("drizzle-orm");
  try {
    const workflows = await db
      .select({
        key: workflow.key,
        title: workflow.title,
        mode: workflow.mode,
        enabled: workflow.enabled,
      })
      .from(workflow)
      .orderBy(workflow.key);

    const nextOccurrences = await db
      .select({
        workflowKey: workflowSchedule.workflowKey,
        nextRunAt: min(workflowSchedule.nextRunAt),
      })
      .from(workflowSchedule)
      .where(eq(workflowSchedule.enabled, true))
      .groupBy(workflowSchedule.workflowKey);
    const nextByWorkflow = new Map(nextOccurrences.map((row) => [row.workflowKey, row.nextRunAt]));

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
      ["KEY", "TITLE", "MODE", "ENABLED", "NEXT RUN"],
      ...workflows.map((w) => [
        w.key,
        w.title,
        w.mode,
        String(w.enabled),
        nextByWorkflow.get(w.key)?.toISOString() ?? "-",
      ]),
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

    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
      return;
  }
}

await main();
