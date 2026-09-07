/** Observe refresh completion before dispatch, including synchronously delivered results. */
export function waitForSessionRefresh(options: {
  readonly subscribe: (check: () => void) => () => void;
  readonly check: () => string;
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
      15_000,
    );
    const check = () => {
      if (done) return;
      const result = options.check();
      if (result === "ready") finish();
      else if (result !== "pending") finish(new Error(result));
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
    void options.reconnect().then(
      (success) => {
        if (!success) finish(new Error("Could not reconnect. Pull down to try again."));
        else check();
      },
      (error: unknown) => finish(error instanceof Error ? error : new Error("Refresh failed.")),
    );
  });
}
