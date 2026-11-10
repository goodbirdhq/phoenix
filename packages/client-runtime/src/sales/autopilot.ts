import type {
  SalesAutopilotItem,
  SalesHoldResult,
  SalesOutOfOffice,
  SalesQueueItemDetail,
  SalesResumeInput,
  SalesResumeResult,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import { emailStepLabel } from "./campaigns.ts";
import { failedOutcome, holdOutcome, resumeOutcome, type SalesHoldOutcome } from "./hold.ts";
import { stateLabel } from "./outreach.ts";
import { salesDay } from "./time.ts";

/** Today's states, in the order the timeline shows them: what needs a look, what is to come, done. */
const STATES = [
  { state: "failed", label: "Failed" },
  { state: "retrying", label: "Retrying" },
  { state: "refused", label: "Needs your approval" },
  { state: "held", label: "Held by the engine" },
  { state: "paused", label: "Paused" },
  { state: "sending", label: "Sending now" },
  { state: "scheduled", label: "Scheduled" },
  { state: "sent", label: "Sent" },
] as const;

export interface SalesAutopilotGroup {
  /** One of the engine's states, or `other` for a state this build does not know. */
  readonly state: string;
  readonly label: string;
  readonly items: ReadonlyArray<SalesAutopilotItem>;
}

export interface SalesAutopilotTimeline {
  readonly groups: ReadonlyArray<SalesAutopilotGroup>;
  readonly shown: number;
  /** Pressed sends left out because the person asked for automated ones only. */
  readonly pressedHidden: number;
}

/**
 * Today's sends, grouped by state in the engine's time order. Automated sends only (the route
 * approved them, or no card was ever drawn) unless `includePressed`.
 */
export function autopilotTimeline(
  items: ReadonlyArray<SalesAutopilotItem>,
  includePressed: boolean,
): SalesAutopilotTimeline {
  const shown = includePressed ? items : items.filter((item) => item.approval !== "press");
  const known = new Set<string>(STATES.map((entry) => entry.state));
  const groups = [
    ...STATES.map(({ state, label }) => ({
      state,
      label,
      items: shown.filter((item) => item.state === state),
    })),
    { state: "other", label: "Other", items: shown.filter((item) => !known.has(item.state)) },
  ].filter((group) => group.items.length > 0);
  return { groups, shown: shown.length, pressedHidden: items.length - shown.length };
}

/** A send's line under its contact: `Email 2 · Fintech Q4 · from gabe@… · approved by you`. */
export function autopilotDetail(item: SalesAutopilotItem): string {
  return [
    item.step === null ? null : emailStepLabel(item.step),
    item.campaign,
    item.mailbox ? `from ${item.mailbox}` : null,
    item.approval === "press" ? "approved by you" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `Away until Thu 12 Nov`, or `Out of office` when their auto-reply names no day. */
export const outOfOfficeLabel = (outOfOffice: SalesOutOfOffice) =>
  outOfOffice.returnOn ? `Away until ${salesDay(outOfOffice.returnOn)}` : "Out of office";

/**
 * What a person can do to one of today's sends: pause a scheduled send the autopilot approved,
 * and resume one that was paused. A send a person approved is held from Outreach; one the engine
 * held needs a press.
 */
export const autopilotActions = (item: Pick<SalesAutopilotItem, "state" | "approval">) => ({
  pause: item.state === "scheduled" && item.approval === "route",
  resume: item.state === "paused",
});

export interface AutopilotCommands {
  readonly hold: (activityId: string) => Promise<AtomCommandResult<SalesHoldResult, unknown>>;
  readonly resume: (
    input: SalesResumeInput,
  ) => Promise<AtomCommandResult<SalesResumeResult, unknown>>;
  readonly getQueueItem: (
    activityId: string,
  ) => Promise<AtomCommandResult<SalesQueueItemDetail, unknown>>;
}

export const pauseSend = async (commands: AutopilotCommands, activityId: string) =>
  holdOutcome(await commands.hold(activityId));

/**
 * Resumes a paused send. Today's list carries no content hash, so the card is read first and
 * resumed for the version the engine shows now; a card no longer paused is left alone.
 */
export async function resumeSend(
  commands: AutopilotCommands,
  activityId: string,
): Promise<SalesHoldOutcome> {
  const read = await commands.getQueueItem(activityId);
  if (read._tag !== "Success") return failedOutcome(read);
  if (read.value.state !== "paused") {
    return {
      kind: "failed",
      tone: "warning",
      title: "No longer paused",
      description: `It is ${stateLabel(read.value.state).toLowerCase()} now.`,
      needsPress: false,
    };
  }
  return resumeOutcome(await commands.resume({ activityId, expectedHash: read.value.contentHash }));
}

/**
 * Runs one action on each send in turn, reporting progress after each, and returns every
 * outcome by activity id. One at a time: each answer is the engine's word on that send.
 */
export async function eachSend(
  activityIds: ReadonlyArray<string>,
  act: (activityId: string) => Promise<SalesHoldOutcome>,
  onProgress: (done: number, outcomes: ReadonlyMap<string, SalesHoldOutcome>) => void,
): Promise<ReadonlyMap<string, SalesHoldOutcome>> {
  const outcomes = new Map<string, SalesHoldOutcome>();
  for (const activityId of activityIds) {
    outcomes.set(activityId, await act(activityId));
    onProgress(outcomes.size, outcomes);
  }
  return outcomes;
}

/** `Paused 7 of 8. 1 was already going and was not stopped. 1 failed.` */
export function batchSummary(
  verb: "Paused" | "Resumed",
  outcomes: ReadonlyArray<SalesHoldOutcome>,
): string {
  const count = (kind: SalesHoldOutcome["kind"]) =>
    outcomes.filter((outcome) => outcome.kind === kind).length;
  const done = count("done") + count("already");
  const going = count("going");
  const failed = count("failed");
  return [
    `${verb} ${done} of ${outcomes.length}.`,
    going > 0
      ? `${going} ${going === 1 ? "was" : "were"} already going and could not be stopped.`
      : null,
    failed > 0 ? `${failed} ${failed === 1 ? "was" : "were"} not ${verb.toLowerCase()}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
