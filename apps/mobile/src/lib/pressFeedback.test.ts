import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPressFeedback,
  PRESS_FEEDBACK_DELAY_MS,
  PRESS_FEEDBACK_FLASH_MS,
} from "./pressFeedback";

// Pressability's press-out is held until this long after the touch began.
const PRESSABILITY_MIN_PRESS_DURATION_MS = 130;

function track() {
  const changes: boolean[] = [];
  const feedback = createPressFeedback((pressed) => changes.push(pressed));
  return { changes, feedback };
}

describe("createPressFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashes a quick tap once, ignoring the delayed press-out", () => {
    const { changes, feedback } = track();
    feedback.pressIn(); // responder grant
    vi.advanceTimersByTime(60);
    feedback.touchEnd(); // finger-up
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(PRESSABILITY_MIN_PRESS_DURATION_MS - 60);
    feedback.pressOut(); // held back by the 130ms minimum press duration
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(PRESS_FEEDBACK_FLASH_MS - (PRESSABILITY_MIN_PRESS_DURATION_MS - 60));
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true, false]);
  });

  it("flashes a tap released between the press-out hold and the paint delay", () => {
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(140);
    feedback.pressOut(); // immediate: past the 130ms minimum
    feedback.touchEnd(); // same event batch
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(PRESS_FEEDBACK_FLASH_MS);
    expect(changes).toEqual([true, false]);
  });

  it("paints once a still press outlasts the delay and clears on release", () => {
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([true]);
    feedback.pressOut();
    feedback.touchEnd();
    expect(changes).toEqual([true, false]);
  });

  it("never paints when a scroll takes the touch before the paint delay", () => {
    // iOS ScrollView takeover: no touch cancel, only a delayed press-out, and
    // the raw touch end arrives at finger-up much later.
    expect(PRESS_FEEDBACK_DELAY_MS).toBeGreaterThan(PRESSABILITY_MIN_PRESS_DURATION_MS);
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(PRESSABILITY_MIN_PRESS_DURATION_MS);
    feedback.pressOut(); // takeover at 80ms, reported at 130ms
    vi.advanceTimersByTime(2000);
    feedback.touchEnd(); // finger-up after the scroll
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
  });

  it("clears at once when a lit press loses the responder before the finger lifts", () => {
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS + 50);
    expect(changes).toEqual([true]);
    feedback.pressOut(); // slow scroll start or left the retention rect
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(2000);
    feedback.touchEnd();
    expect(changes).toEqual([true, false]);
  });

  it("never arms the row for a press a nested pressable owns", () => {
    // The avatar (or PR label, agent group) is granted the responder. Its raw
    // touch end bubbles through the row, but only the child gets press-in.
    const row = track();
    const child = track();
    child.feedback.pressIn();
    vi.advanceTimersByTime(2000);
    expect(child.changes).toEqual([true]);
    expect(row.changes).toEqual([]);
    child.feedback.pressOut();
    child.feedback.touchEnd();
    row.feedback.touchEnd(); // the same touch end, bubbled to the row
    expect(row.changes).toEqual([]);
  });

  it("does not let a flash leak into the next press", () => {
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(60);
    feedback.touchEnd();
    expect(changes).toEqual([true]);
    feedback.pressIn(); // second tap during the flash
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(PRESS_FEEDBACK_FLASH_MS);
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(PRESS_FEEDBACK_DELAY_MS - PRESS_FEEDBACK_FLASH_MS);
    expect(changes).toEqual([true, false, true]);
  });

  it("ends a flash immediately on unmount", () => {
    const { changes, feedback } = track();
    feedback.pressIn();
    vi.advanceTimersByTime(60);
    feedback.touchEnd();
    feedback.end();
    expect(changes).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true, false]);
  });
});
