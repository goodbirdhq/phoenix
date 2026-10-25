import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentUser } from "~/server/functions";
import { AuthForm } from "~/components/auth-form";
export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await currentUser()) throw redirect({ to: "/dashboard" });
  },
  component: () => <AuthForm />,
});
