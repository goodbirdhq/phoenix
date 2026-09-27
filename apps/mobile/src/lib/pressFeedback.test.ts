import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPressFeedback, PRESS_FEEDBACK_DELAY_MS } from "./pressFeedback";

describe("createPressFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never paints for a tap shorter than the delay", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(60);
    feedback.touchEnd();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
  });

  it("paints once a still touch outlasts the delay and clears on release", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true]);
    feedback.touchEnd();
    expect(changes).toEqual([true, false]);
  });

  it("clears immediately when a held touch is cancelled by a scroll", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(150);
    feedback.touchEnd();
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true, false]);
  });

  it("restarts the wait for a new touch after an early cancel", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(100);
    feedback.touchEnd();
    feedback.touchDown();
    vi.advanceTimersByTime(100);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(changes).toEqual([true]);
  });
});
