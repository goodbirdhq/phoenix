/**
 * A contract violation the same handler cannot recover from by running
 * again — bad payload shape, an unknown workflow key, and the like. Throwing
 * this from a job handler skips the normal retry ladder and fails the job on
 * the current attempt.
 */
export class TerminalJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalJobError";
  }
}

export function isTerminalJobError(error: unknown): error is TerminalJobError {
  return error instanceof TerminalJobError;
}

/**
 * A run stopped because its lease was gone, not because the work itself
 * failed. Deliberately not a `TerminalJobError`: losing a lease is an
 * infrastructure event, so the attempt is retried under the ordinary
 * `maxAttempts` policy rather than dead-lettered outright.
 */
export class JobLeaseLostError extends Error {
  readonly reason: "lost" | "expired";
  readonly jobId: string;

  constructor(reason: "lost" | "expired", jobId: string) {
    super(`Job ${jobId} lost its lease (${reason})`);
    this.name = "JobLeaseLostError";
    this.reason = reason;
    this.jobId = jobId;
  }
}
