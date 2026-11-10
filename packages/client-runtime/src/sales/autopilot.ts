import type { SalesAutopilotItem } from "@t3tools/contracts";

/** Today's states, in the order the timeline shows them: what needs a look, what is to come, done. */
const STATES = [
  { state: "failed", label: "Failed" },
  { state: "retrying", label: "Retrying" },
  { state: "refused", label: "Refused, waiting for a press" },
  { state: "held", label: "Held" },
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
