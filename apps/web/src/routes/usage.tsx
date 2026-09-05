import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  validateSearch: (search: Record<string, unknown>): { account?: string } =>
    typeof search.account === "string" && search.account.length > 0
      ? { account: search.account }
      : {},
  component: UsagePage,
});
