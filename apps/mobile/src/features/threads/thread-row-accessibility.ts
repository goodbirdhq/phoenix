// Spoken text for thread-list rows. Screen readers get the same facts the row
// shows visually: title, outbox state, identity, last error, and wake time.

const MAX_SPOKEN_ERROR_LENGTH = 120;

/**
 * One line of the error, cut at a word so a stack trace does not become the
 * label. The ellipsis counts toward the cap.
 */
export function truncateSpokenError(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_SPOKEN_ERROR_LENGTH) return text;
  const cut = text.slice(0, MAX_SPOKEN_ERROR_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_SPOKEN_ERROR_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function buildThreadRowAccessibilityLabel(input: {
  readonly title: string;
  readonly hasQueuedMessages: boolean;
  /** Status, provider and model, from threadIdentityLabel. */
  readonly identityLabel: string;
  /** Last session error while the row's status is failed. */
  readonly failedError: string | null;
  /** Wake countdown as the row shows it ("45m", "2h", "now"); undefined when not snoozed. */
  readonly snoozeWakeLabel: string | undefined;
}): string {
  return [
    input.title,
    input.hasQueuedMessages ? "messages queued to send" : null,
    input.identityLabel,
    input.failedError ? truncateSpokenError(input.failedError) : null,
    input.snoozeWakeLabel === undefined
      ? null
      : input.snoozeWakeLabel === "now"
        ? "Wakes now"
        : `Wakes in ${input.snoozeWakeLabel}`,
  ]
    .filter(Boolean)
    .join(". ");
}

/** Draft rows never send on their own; queued rows send when the environment reconnects. */
export function pendingTaskRowAccessibility(input: {
  readonly kind: "draft" | "pending";
  readonly title: string;
  readonly projectTitle: string;
  readonly environmentLabel: string | null;
}) {
  const isDraft = input.kind === "draft";
  return {
    label: [input.title, isDraft ? "Draft" : "Queued", input.projectTitle, input.environmentLabel]
      .filter(Boolean)
      .join(", "),
    hint: isDraft
      ? "Opens the draft in the new task composer"
      : "Sends when the environment reconnects. Opens the task for editing",
    deleteActionLabel: isDraft ? "Delete draft" : "Delete queued task",
  };
}
