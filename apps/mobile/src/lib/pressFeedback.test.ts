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
    feedback.pressIn(); // responder grant
    vi.advanceTimersByTime(60);
    feedback.end(); // touch end
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
  });

  it("paints once a still touch outlasts the delay and clears on release", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.pressIn();
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
    feedback.pressIn();
    vi.advanceTimersByTime(PRESSABILITY_MIN_PRESS_DURATION_MS);
    feedback.end(); // onPressOut for a takeover at 80ms, delivered at 130ms
    vi.advanceTimersByTime(2000);
    feedback.end(); // touch end at finger-up
    expect(changes).toEqual([]);
  });

  it("clears at once when a lit press loses the responder before the finger lifts", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.pressIn();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS + 50);
    expect(changes).toEqual([true]);
    feedback.end(); // onPressOut: slow scroll start or left the retention rect
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(2000);
    feedback.end(); // touch end at finger-up
    expect(changes).toEqual([true, false]);
  });

  it("never arms the row for a press a nested pressable owns", () => {
    // The avatar (or PR label, agent group) is granted the responder. Its raw
    // touch events bubble through the row, but only the child gets press-in,
    // and only the child would get press-out when a scroll takes over.
    const rowChanges: boolean[] = [];
    const childChanges: boolean[] = [];
    const row = createPressFeedback((pressed) => rowChanges.push(pressed));
    const child = createPressFeedback((pressed) => childChanges.push(pressed));
    child.pressIn();
    vi.advanceTimersByTime(2000);
    expect(childChanges).toEqual([true]);
    expect(rowChanges).toEqual([]);
    child.end(); // child touch end
    row.end(); // the same touch end, bubbled to the row
    expect(rowChanges).toEqual([]);
  });

  it("restarts the wait for a new press after an early end", () => {
    const changes: boolean[] = [];
    const feedback = createPressFeedback((pressed) => changes.push(pressed));
    feedback.pressIn();
    vi.advanceTimersByTime(100);
    feedback.end();
    feedback.pressIn();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS - 20);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(changes).toEqual([true]);
  });
});
