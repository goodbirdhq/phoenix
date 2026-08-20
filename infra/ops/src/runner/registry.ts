import type { JobHandlerRegistry } from "../jobs/types.js";

/**
 * All job handlers the worker drains. The runner module (wave 2) registers
 * its launch/watch handlers here; the scheduler and CLI import only this.
 */
export const jobHandlerRegistry: JobHandlerRegistry = new Map();
