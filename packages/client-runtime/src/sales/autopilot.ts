import type { SalesAutopilotItem, SalesOutOfOffice } from "@t3tools/contracts";

import { emailStepLabel } from "./campaigns.ts";
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
