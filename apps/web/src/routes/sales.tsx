import { createFileRoute } from "@tanstack/react-router";

import { SalesPage } from "../components/sales/SalesPage";

export type SalesArea = "outreach" | "conversations";

export interface SalesSearch {
  readonly environment?: string;
  /** The work area shown; Home when absent. */
  readonly area?: SalesArea;
  /** The selected draft (Outreach: activityId) or contact (Conversations: contactKey). */
  readonly item?: string;
}

const AREAS = new Set<string>(["outreach", "conversations"]);

export const Route = createFileRoute("/sales")({
  validateSearch: (raw: Record<string, unknown>): SalesSearch => ({
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment }
      : {}),
    ...(typeof raw.area === "string" && AREAS.has(raw.area) ? { area: raw.area as SalesArea } : {}),
    ...(typeof raw.item === "string" && raw.item ? { item: raw.item } : {}),
  }),
  component: SalesPage,
});
