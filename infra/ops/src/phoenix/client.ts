import type { OpsConfig } from "../config.ts";

/**
 * Seam for the Phoenix-side integration: launching an agent session and
 * wiring its result callback is built separately, against Phoenix's HTTP
 * API. This interface exists so the rest of the ops hub can depend on the
 * *shape* of that integration — dispatch a workflow's skill, get back a
 * thread id — without depending on its implementation.
 */
export interface PhoenixClient {
  /**
   * Starts an agent thread running the given skill and returns its id. The
   * agent is expected to call back to `callbackUrl` with its result; this
   * call only confirms the launch, not completion — callers must not block
   * on it for the run's outcome.
   */
  dispatchWorkflowThread(input: {
    skillPath: string;
    input: Record<string, unknown>;
    callbackUrl: string;
    callbackToken: string;
  }): Promise<{ threadId: string }>;
}

/**
 * Not implemented yet — the real client lands with the Phoenix-side
 * integration. Kept here, typed, so callers can be written against the
 * final interface now.
 */
export function createPhoenixClient(
  config: Pick<OpsConfig, "PHOENIX_BASE_URL" | "PHOENIX_OPS_TOKEN">,
): PhoenixClient {
  void config;
  throw new Error(
    "createPhoenixClient is not implemented yet — the Phoenix-side dispatch integration lands in a later wave",
  );
}
