// Pressability reports responder loss through onPressOut, but holds that call
// until 130ms after the touch began (DEFAULT_MIN_PRESS_DURATION; Pressable does
// not forward minPressDuration). Painting later than that means a scroll or
// swipe that takes the touch early is always reported before the fill appears,
// while a finger resting on the row still lights it promptly.
export const PRESS_FEEDBACK_DELAY_MS = 150;
// A tap that lifts before the delay still gets acknowledged, briefly.
export const PRESS_FEEDBACK_FLASH_MS = 90;

/**
 * Pressed fill timing for rows. Pressable's own `pressed` activates on release
 * for quick taps and can outlive a scroll start, so this runs alongside it.
 * Arm it from the row's own onPressIn, which fires at responder grant, so a
 * touch that a nested pressable owns never arms the row (its press-out would
 * never reach the row). A press that stays down paints after the delay. A raw
 * touch end while still armed is a real finger-up on a row-owned tap and
 * flashes the fill. onPressOut is the only signal on iOS when the ScrollView
 * takes the gesture or the finger leaves the retention rect: while armed it
 * disarms on the next tick, so no flash, unless a touch end in the same event
 * batch shows it was a release. Once ended, nothing paints until the next
 * press-in.
 */
export function createPressFeedback(
  onChange: (pressed: boolean) => void,
  delayMs = PRESS_FEEDBACK_DELAY_MS,
  flashMs = PRESS_FEEDBACK_FLASH_MS,
) {
  type Timer = ReturnType<typeof setTimeout>;
  let armTimer: Timer | null = null;
  let flashTimer: Timer | null = null;
  let pressOutTimer: Timer | null = null;
  let pressed = false;
  const set = (next: boolean) => {
    if (pressed === next) return;
    pressed = next;
    onChange(next);
  };
  const clearArm = () => {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
  };
  const clearFlash = () => {
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = null;
  };
  const clearPressOut = () => {
    if (pressOutTimer !== null) clearTimeout(pressOutTimer);
    pressOutTimer = null;
  };
  const reset = () => {
    clearArm();
    clearFlash();
    clearPressOut();
    set(false);
  };
  return {
    /** The row was granted the responder; nested pressables own their own grants. */
    pressIn() {
      reset();
      armTimer = setTimeout(() => {
        armTimer = null;
        set(true);
      }, delayMs);
    },
    /** Raw finger-up. Flashes a tap that lifted before the delay; ends a lit hold. */
    touchEnd() {
      clearPressOut();
      if (armTimer !== null) {
        clearArm();
        set(true);
        flashTimer = setTimeout(() => {
          flashTimer = null;
          set(false);
        }, flashMs);
        return;
      }
      if (flashTimer === null) set(false);
    },
    /** Pressability press-out: release, responder loss, or leaving the retention rect. */
    pressOut() {
      // The 130ms-delayed press-out of a tap that is already flashing.
      if (flashTimer !== null) return;
      if (armTimer !== null) {
        // Release and takeover look alike here; a touch end in this same
        // event batch tells them apart before the disarm runs.
        if (pressOutTimer === null) {
          pressOutTimer = setTimeout(() => {
            pressOutTimer = null;
            clearArm();
            set(false);
          }, 0);
        }
        return;
      }
      set(false);
    },
    /** Unmount: everything off, no flash. */
    end: reset,
  };
}
