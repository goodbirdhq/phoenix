// A touch that turns into a scroll or swipe is cancelled within this window,
// so a fill that waits this long only ever shows for a finger resting on a row.
export const PRESS_FEEDBACK_DELAY_MS = 120;

/**
 * Pressed fill timing driven by raw touch events, not Pressability's pressed
 * state: that one activates on release for taps shorter than its press delay
 * and holds press-out for 130ms, so it can flash after navigation or after a
 * scroll start. This paints only once a touch has stayed down for the delay,
 * and clears the moment the touch ends or is cancelled.
 */
export function createPressFeedback(
  onChange: (pressed: boolean) => void,
  delayMs = PRESS_FEEDBACK_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressed = false;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const set = (next: boolean) => {
    if (pressed === next) return;
    pressed = next;
    onChange(next);
  };
  return {
    touchDown() {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        set(true);
      }, delayMs);
    },
    /** Release, cancel, or responder termination: all end the fill at once. */
    touchEnd() {
      clearTimer();
      set(false);
    },
  };
}
