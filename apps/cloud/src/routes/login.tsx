import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUser } from "~/server/functions";
import { AuthForm } from "~/components/auth-form";
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect:
      typeof search.redirect === "string" && /^\/device(?:\?|$)/.test(search.redirect)
        ? search.redirect
        : "/dashboard",
  }),
  beforeLoad: async ({ search }) => {
    if (await currentUser()) throw redirect({ href: search.redirect ?? "/dashboard" });
  },
  component: () => <AuthForm redirectTo={Route.useSearch().redirect ?? "/dashboard"} />,
});
