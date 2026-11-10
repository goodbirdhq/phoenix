/** The Sales areas with a screen, in the order clients list them. */
export const SALES_AREA_KEYS = [
  "outreach",
  "autopilot",
  "todo",
  "conversations",
  "campaigns",
  "health",
] as const;

export type SalesArea = (typeof SALES_AREA_KEYS)[number];

export const isSalesArea = (key: unknown): key is SalesArea =>
  SALES_AREA_KEYS.some((area) => area === key);

/** What each area is called, wherever a client names it. */
export const SALES_AREA_LABELS: Record<SalesArea, string> = {
  outreach: "Outreach",
  autopilot: "Autopilot",
  todo: "To do",
  conversations: "Conversations",
  campaigns: "Campaigns",
  health: "Health",
};
