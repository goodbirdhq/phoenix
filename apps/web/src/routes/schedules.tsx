import { createFileRoute } from "@tanstack/react-router";
import { SchedulesPage } from "../components/schedules/SchedulesPage";

export interface SchedulesSearch {
  readonly create?: string;
  readonly environment?: string;
  readonly schedule?: string;
  readonly tab?: "overview" | "history";
  readonly edit?: boolean;
  readonly duplicate?: boolean;
}

function parseSchedulesSearch(raw: Record<string, unknown>): SchedulesSearch {
  return {
    ...(typeof raw.create === "string" && raw.create
      ? { create: raw.create }
      : raw.create === true
        ? { create: "initial" }
        : {}),
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment }
      : {}),
    ...(typeof raw.schedule === "string" && raw.schedule ? { schedule: raw.schedule } : {}),
    ...(raw.tab === "overview" || raw.tab === "history" ? { tab: raw.tab } : {}),
    ...(raw.edit === true ? { edit: true } : {}),
    ...(raw.duplicate === true ? { duplicate: true } : {}),
  };
}
export const Route = createFileRoute("/schedules")({
  validateSearch: parseSchedulesSearch,
  component: SchedulesPage,
});
