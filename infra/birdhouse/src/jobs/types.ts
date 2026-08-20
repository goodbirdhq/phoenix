import type { opsJob } from "../db/schema.ts";

export type OpsJobRow = typeof opsJob.$inferSelect;
export type OpsJobRetryBackoff = OpsJobRow["retryBackoff"];

export type EnqueueJobInput = Readonly<{
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  retryBackoff?: OpsJobRetryBackoff;
  retryDelayMs?: number;
  runAfter?: Date;
}>;

/** A lease actively held on one job for the duration of a handler's run. */
export type ActiveJobLease = Readonly<{
  jobId: string;
  workerId: string;
  leaseVersion: number;
  leaseMs: number;
  /**
   * Aborts as soon as the lease is provably gone. A handler doing anything
   * with an external, non-idempotent side effect must watch this: every
   * unit of work done after it fires may be re-done by whichever worker
   * leases the job next.
   */
  leaseLostSignal: AbortSignal;
}>;

export type JobHandlerResult = Record<string, unknown> | undefined;

export type JobHandler = (job: OpsJobRow, lease: ActiveJobLease) => Promise<JobHandlerResult>;

export type JobHandlerDefinition = Readonly<{
  type: string;
  handle: JobHandler;
}>;

/** Keyed by job `type`. Built with `defineJobHandler` + a plain object or `Map`. */
export type JobHandlerRegistry = ReadonlyMap<string, JobHandlerDefinition>;

export function defineJobHandler(definition: JobHandlerDefinition): JobHandlerDefinition {
  return definition;
}

export function createJobHandlerRegistry(
  definitions: readonly JobHandlerDefinition[],
): JobHandlerRegistry {
  const registry = new Map<string, JobHandlerDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.type)) {
      throw new Error(`Duplicate job handler registered for type "${definition.type}"`);
    }
    registry.set(definition.type, definition);
  }
  return registry;
}
