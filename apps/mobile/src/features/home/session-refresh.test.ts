import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { waitForSessionRefresh } from "./session-refresh";

function fixture() {
  let status = "pending";
  let notify = () => {};
  const unsubscribe = vi.fn();
  const controller = new AbortController();
  const reconnect = vi.fn(async () => true);
  const options = {
    subscribe: (check: () => void) => {
      notify = check;
      return unsubscribe;
    },
    check: () => status,
    reconnect,
    signal: controller.signal,
  };
  return {
    options,
    controller,
    unsubscribe,
    emit: (value: string) => {
      status = value;
      notify();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("session refresh", () => {
  it("waits for live data after reconnect dispatch, then releases its subscription", async () => {
    const f = fixture();
    const settled = vi.fn();
    const result = waitForSessionRefresh(f.options).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.emit("ready");
    await result;
    expect(settled).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("observes completion delivered during reconnect", async () => {
    const f = fixture();
    f.options.reconnect.mockImplementation(async () => {
      f.emit("ready");
      return true;
    });
    await waitForSessionRefresh(f.options);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports connection failure and releases the observer", async () => {
    const f = fixture();
    const result = waitForSessionRefresh(f.options);
    f.emit("You are offline.");
    await expect(result).rejects.toThrow("You are offline.");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports a rejected reconnect command", async () => {
    const f = fixture();
    f.options.reconnect.mockResolvedValue(false);
    await expect(waitForSessionRefresh(f.options)).rejects.toThrow("Could not reconnect");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cancels on unmount without retaining listeners", async () => {
    const f = fixture();
    const result = waitForSessionRefresh(f.options);
    f.controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not reconnect after cancellation before mounting", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(waitForSessionRefresh(f.options)).rejects.toThrow("cancelled");
    expect(f.options.reconnect).not.toHaveBeenCalled();
  });

  it("does not read state when a queued reconnect finishes after cancellation", async () => {
    const f = fixture();
    let finishDispatch = (_success: boolean) => {};
    f.options.reconnect.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const check = vi.fn(f.options.check);
    const result = waitForSessionRefresh({ ...f.options, check });
    f.controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    finishDispatch(true);
    await Promise.resolve();
    expect(check).not.toHaveBeenCalled();
  });

  it("bounds a server that never completes synchronization", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = expect(waitForSessionRefresh(f.options)).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});
