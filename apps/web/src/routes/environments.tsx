import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentsPage } from "../components/environments/EnvironmentsPage";

export const Route = createFileRoute("/environments")({
  component: EnvironmentsPage,
});
