import { createFileRoute } from "@tanstack/react-router";

import { SchedulesPage } from "../components/schedules/SchedulesPage";

export interface SchedulesSearch {
  readonly create?: string;
}

export const Route = createFileRoute("/schedules")({
  validateSearch: (raw: Record<string, unknown>): SchedulesSearch =>
    typeof raw.create === "string" && raw.create.length > 0
      ? { create: raw.create }
      : raw.create === true
        ? { create: "initial" }
        : {},
  component: SchedulesRouteView,
});

function SchedulesRouteView() {
  const search = Route.useSearch();
  return <SchedulesPage openCreateRequest={search.create ?? null} />;
}
