import { createFileRoute } from "@tanstack/react-router";

import { isSalesArea, type SalesArea } from "../components/sales/areas";
import { SalesPage } from "../components/sales/SalesPage";

export interface SalesSearch {
  readonly environment?: string;
  /** The work area shown; Home when absent. */
  readonly area?: SalesArea;
  /** The selected draft (Outreach: activityId) or contact (Conversations: contactKey). */
  readonly item?: string;
}

export const Route = createFileRoute("/sales")({
  validateSearch: (raw: Record<string, unknown>): SalesSearch => ({
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment }
      : {}),
    ...(isSalesArea(raw.area) ? { area: raw.area } : {}),
    ...(typeof raw.item === "string" && raw.item ? { item: raw.item } : {}),
  }),
  component: SalesPage,
});
