// Pressability reports responder loss through onPressOut, but holds that call
// until 130ms after the touch began (DEFAULT_MIN_PRESS_DURATION; Pressable does
// not forward minPressDuration). Painting later than that means a scroll or
// swipe that takes the touch early is always reported before the fill appears,
// while a finger resting on the row still lights it promptly.
export const PRESS_FEEDBACK_DELAY_MS = 150;

/**
 * Pressed fill timing for rows. Pressable's own `pressed` activates on release
 * for quick taps and can outlive a scroll start, so this runs alongside it:
 * paint only once a press has stayed down for the delay, and end at the first
 * sign it is over or no longer a press. Arm it from the row's own onPressIn,
 * which fires at responder grant, so a touch that a nested pressable owns
 * never arms the row (its press-out would never reach the row to end it).
 * End it on raw touch end and cancel, plus onPressOut, which is the only
 * signal on iOS when the ScrollView takes the gesture or the finger leaves
 * the retention rect. Once ended, nothing paints until the next press-in.
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
    /** The row was granted the responder; nested pressables own their own grants. */
    pressIn() {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        set(true);
      }, delayMs);
    },
    /** Touch end, touch cancel, or press-out: the fill ends and stays off. */
    end() {
      clearTimer();
      set(false);
    },
  };
}
