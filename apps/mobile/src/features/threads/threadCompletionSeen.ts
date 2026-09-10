/** Return the loaded completion to acknowledge, or null when it has not
 * actually been viewed. Kept separate from React and persistence so the
 * foreground and disabled-mode rules can be checked deterministically.
 */
export function threadCompletionSeenAt(input: {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly foreground: boolean;
  readonly completedAt: string | null;
  readonly lastVisitedAt: string | undefined;
}): string | null {
  if (!input.enabled || !input.visible || !input.foreground || input.completedAt === null)
    return null;
  const completedAt = Date.parse(input.completedAt);
  if (!Number.isFinite(completedAt) || Date.parse(input.lastVisitedAt ?? "") >= completedAt)
    return null;
  return input.completedAt;
}
