import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentsPage } from "../components/environments/EnvironmentsPage";

export const Route = createFileRoute("/environments")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    environment?: string | undefined;
    tab?: string | undefined;
    edit?: boolean | undefined;
    add?: boolean | undefined;
  } => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
    tab:
      typeof search.tab === "string" &&
      ["overview", "projects", "providers", "connections", "access"].includes(search.tab)
        ? search.tab
        : "overview",
    edit: search.edit === true || search.edit === "true" ? true : undefined,
    add: search.add === true || search.add === "true" ? true : undefined,
  }),
  component: EnvironmentsPage,
});
