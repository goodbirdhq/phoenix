import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPressFeedback, PRESS_FEEDBACK_DELAY_MS } from "./pressFeedback";

// Pressability's press-out is held until this long after the touch began.
const PRESSABILITY_MIN_PRESS_DURATION_MS = 130;

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
    feedback.end(); // touch end
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
    feedback.end(); // touch end
    expect(changes).toEqual([true, false]);
  });

  it("waits past Pressability's press-out hold so an early scroll takeover never paints", () => {
    // iOS ScrollView takeover: no touch cancel, only a delayed press-out, and
    // raw touch events keep flowing until the finger lifts much later.
    expect(PRESS_FEEDBACK_DELAY_MS).toBeGreaterThan(PRESSABILITY_MIN_PRESS_DURATION_MS);
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(PRESSABILITY_MIN_PRESS_DURATION_MS);
    feedback.end(); // onPressOut for a takeover at 80ms, delivered at 130ms
    vi.advanceTimersByTime(2000);
    feedback.end(); // touch end at finger-up
    expect(changes).toEqual([]);
  });

  it("clears at once when a lit press loses the responder before the finger lifts", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS + 50);
    expect(changes).toEqual([true]);
    feedback.end(); // onPressOut: slow scroll start or left the retention rect
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(2000);
    feedback.end(); // touch end at finger-up
    expect(changes).toEqual([true, false]);
  });

  it("restarts the wait for a new touch after an early end", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.touchDown();
    vi.advanceTimersByTime(100);
    feedback.end();
    feedback.touchDown();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS - 20);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(changes).toEqual([true]);
  });
});
