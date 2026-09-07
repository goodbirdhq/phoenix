import { CONNECTION_ESTABLISHMENT_TIMEOUT_MS } from "@t3tools/client-runtime/connection";
import type { SessionRefreshResult } from "./session-refresh.logic";

// Include connection teardown and the subsequent shell snapshot synchronization.
export const SESSION_REFRESH_TIMEOUT_MS = CONNECTION_ESTABLISHMENT_TIMEOUT_MS + 10_000;

/** Observe refresh completion before dispatch, including synchronously delivered results. */
export function waitForSessionRefresh(options: {
  readonly subscribe: (check: () => void) => () => void;
  readonly check: () => SessionRefreshResult;
  readonly reconnect: () => Promise<boolean>;
  readonly signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      unsubscribe();
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Refresh cancelled."));
    const timeout = setTimeout(
      () => finish(new Error("The environment did not respond. Pull down to try again.")),
      SESSION_REFRESH_TIMEOUT_MS,
    );
    const check = () => {
      if (done) return;
      const result = options.check();
      if (result.status === "ready") finish();
      else if (result.status === "error") finish(new Error(result.message));
    };
    options.signal.addEventListener("abort", abort);
    if (options.signal.aborted) {
      abort();
      return;
    }
    unsubscribe = options.subscribe(check);
    if (done) {
      unsubscribe();
      return;
    }
    try {
      void options.reconnect().then(
        (success) => {
          if (!success) finish(new Error("Could not reconnect. Pull down to try again."));
          else check();
        },
        (error: unknown) => finish(error instanceof Error ? error : new Error("Refresh failed.")),
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Refresh failed."));
    }
  });
}
