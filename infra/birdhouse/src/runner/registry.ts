import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { createJobHandlerRegistry } from "../jobs/types.ts";
import type { JobHandlerRegistry } from "../jobs/types.ts";
import { createPhoenixClient } from "../phoenix/client.ts";
import {
  createWorkflowLaunchHandler,
  createWorkflowStopHandler,
  createWorkflowWatchHandler,
} from "./handlers.ts";

// Importing `db/client.ts` validates BIRDHOUSE_DATABASE_URL at import time (see
// that module's own comment) — same as every other real (non-stub) module in
// this package. Unlike cli.ts's top-level commands, nothing here needs to
// print usage without a configured database, so there is no reason to defer
// this import; callers that DO need an unconfigured-DB-safe path (e.g. `ops
// list` with no database yet) should import this module lazily, the same
// way cli.ts already lazily imports db/client.ts and jobs/queue.ts.
const phoenixClient = createPhoenixClient(config);

/**
 * All job handlers the worker drains. The runner module (wave 2) registers
 * its launch/watch handlers here; the scheduler and CLI import only this.
 */
export const jobHandlerRegistry: JobHandlerRegistry = createJobHandlerRegistry([
  createWorkflowLaunchHandler({ db, phoenixClient }),
  createWorkflowWatchHandler({ db, phoenixClient }),
  createWorkflowStopHandler({ db, phoenixClient }),
]);
