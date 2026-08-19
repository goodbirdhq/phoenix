import { createFileRoute } from "@tanstack/react-router";

import { SchedulesPage } from "../components/schedules/SchedulesPage";

export interface SchedulesSearch {
  readonly create?: boolean;
}

export const Route = createFileRoute("/schedules")({
  validateSearch: (raw: Record<string, unknown>): SchedulesSearch =>
    raw.create === true || raw.create === "true" || raw.create === "1" ? { create: true } : {},
  component: SchedulesRouteView,
});

function SchedulesRouteView() {
  const search = Route.useSearch();
  return <SchedulesPage openCreateInitially={search.create === true} />;
}
