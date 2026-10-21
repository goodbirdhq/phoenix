import { resolveThreadListV2Status, type ThreadListV2Status } from "./threadListV2";

/** What a session avatar's ring says. Snoozed is the row's shelf, not runtime state. */
export type ThreadAvatarStatus = ThreadListV2Status | "snoozed";

type StatusThread = Parameters<typeof resolveThreadListV2Status>[0];

export function resolveThreadAvatarStatus(
  thread: StatusThread,
  options: { readonly snoozed: boolean },
): ThreadAvatarStatus {
  return options.snoozed ? "snoozed" : resolveThreadListV2Status(thread);
}

const SPOKEN_STATUS: Record<ThreadAvatarStatus, string> = {
  snoozed: "Snoozed",
  working: "Working",
  approval: "Awaiting approval",
  input: "Awaiting input",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Usage limited",
  ready: "Ready",
};

/** Spoken identity for the decorative avatar: status, provider, model. */
export function threadIdentityLabel(
  thread: StatusThread & { readonly modelSelection: { readonly model: string } },
  options: { readonly snoozed: boolean; readonly providerName: string | null },
): string {
  return [
    SPOKEN_STATUS[resolveThreadAvatarStatus(thread, options)],
    options.providerName,
    thread.modelSelection.model,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Working rings show motion instead of a badge, and a resting thread needs
 * none. Everything else asks for a glance, so it gets the corner glyph.
 */
export function threadAvatarHasStatusBadge(
  status: ThreadAvatarStatus,
): status is Exclude<ThreadAvatarStatus, "working" | "ready"> {
  return status !== "working" && status !== "ready";
}
