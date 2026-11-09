import { createFileRoute } from "@tanstack/react-router";

import { SalesPage } from "../components/sales/SalesPage";

export interface SalesSearch {
  readonly environment?: string;
}

export const Route = createFileRoute("/sales")({
  validateSearch: (raw: Record<string, unknown>): SalesSearch =>
    typeof raw.environment === "string" && raw.environment ? { environment: raw.environment } : {},
  component: SalesPage,
});
