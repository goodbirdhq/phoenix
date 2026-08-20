#!/usr/bin/env node
const USAGE = `Usage: ops <command>

Commands:
  worker                Apply pending migrations, then drain ready jobs until stopped
  migrate                Apply pending database migrations
  run <workflow-key>      Launch one workflow run immediately (not yet implemented)
  list                    List registered workflows (not yet implemented)
`;

// Deferred, rather than top-level imports: these pull in `db/client.ts`,
// which validates OPS_DATABASE_URL at import time. `run`, `list`, and a bare
// `ops` with no/unknown command must be able to print usage without a
// database configured.
async function runWorker(): Promise<void> {
  const { closeDb, db } = await import("./db/client.ts");
  const { runMigrations } = await import("./db/migrate.ts");
  const { createJobHandlerRegistry, runReadyJobs } = await import("./jobs/queue.ts");

  await runMigrations();

  // TODO: register workflow-run job handlers here once the runner
  // (launch-thread / handle-callback) lands; an empty registry still drains
  // cleanly, it just fails any job with an unrecognised type.
  const registry = createJobHandlerRegistry([]);
  const workerId = `ops-worker-${process.pid}-${Date.now().toString(36)}`;

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(JSON.stringify({ event: "worker.started", workerId }));
  try {
    await runReadyJobs(db, registry, workerId, { signal: controller.signal });
  } finally {
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "worker":
      await runWorker();
      return;

    case "migrate":
      await runMigrateCommand();
      return;

    case "run": {
      const workflowKey = args[0];
      if (!workflowKey) {
        console.error("Usage: ops run <workflow-key>");
        process.exitCode = 1;
        return;
      }
      console.error(
        `"ops run ${workflowKey}" is not implemented yet — manual workflow dispatch lands in a later wave.`,
      );
      process.exitCode = 1;
      return;
    }

    case "list":
      console.error('"ops list" is not implemented yet — workflow listing lands in a later wave.');
      process.exitCode = 1;
      return;

    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
      return;
  }
}

await main();
