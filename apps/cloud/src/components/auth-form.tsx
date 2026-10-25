import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, LockKeyhole, Mail, UserRound } from "lucide-react";
import { authClient } from "~/lib/auth-client";
import { useAppForm } from "~/lib/form";
import { loginInput, signupInput } from "~/lib/validation";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Brand } from "./brand";

export function AuthForm({
  signup = false,
  redirectTo = "/dashboard",
}: {
  signup?: boolean;
  redirectTo?: string;
}) {
  const [error, setError] = useState("");
  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "", inviteCode: "" },
    validators: { onSubmit: signup ? signupInput : loginInput },
    onSubmit: async ({ value }) => {
      setError("");
      try {
        const result = signup
          ? await authClient.signUp.email(value)
          : await authClient.signIn.email({ email: value.email, password: value.password });
        if (result.error) {
          setError(result.error.message ?? "We couldn't sign you in. Please try again.");
          return;
        }
        window.location.assign(redirectTo);
      } catch {
        setError("Couldn't reach Phoenix Cloud. Please try again.");
      }
    },
  });
  return (
    <div className="auth-page">
      <header>
        <Brand />
        <Link to="/">
          Back to home <ArrowRight size={15} />
        </Link>
      </header>
      <main className="auth-layout">
        <Card>
          <CardContent>
            <div className="auth-content">
              <span className="eyebrow">MAKE ROOM FOR WHAT'S NEXT</span>
              <h1>{signup ? "Create your account" : "Welcome back"}</h1>
              <p>
                {signup
                  ? "A little less setup. A little more building."
                  : "Your workspaces are right where you left them."}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                {signup && (
                  <form.AppField name="name">
                    {(field) => (
                      <field.TextField
                        label="Name"
                        autoComplete="name"
                        required
                        maxLength={80}
                        icon={<UserRound />}
                      />
                    )}
                  </form.AppField>
                )}
                <form.AppField name="email">
                  {(field) => (
                    <field.TextField
                      label="Email"
                      type="email"
                      autoComplete="email"
                      required
                      icon={<Mail />}
                    />
                  )}
                </form.AppField>
                <form.AppField name="password">
                  {(field) => (
                    <field.TextField
                      label="Password"
                      type="password"
                      autoComplete={signup ? "new-password" : "current-password"}
                      required
                      minLength={signup ? 12 : 1}
                      maxLength={128}
                      icon={<LockKeyhole />}
                    />
                  )}
                </form.AppField>
                {signup && <p className="field-hint">Use at least 12 characters.</p>}
                {signup && (
                  <form.AppField name="inviteCode">
                    {(field) => (
                      <field.TextField
                        label="Invite code"
                        inputMode="numeric"
                        autoComplete="off"
                        required
                        minLength={6}
                        maxLength={6}
                        pattern="[0-9]{6}"
                      />
                    )}
                  </form.AppField>
                )}
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <form.Subscribe selector={(state) => state.isSubmitting}>
                  {(busy) => (
                    <Button size="lg" type="submit" disabled={busy}>
                      {busy ? "Please wait…" : signup ? "Create account" : "Log in"}
                      <ArrowRight />
                    </Button>
                  )}
                </form.Subscribe>
              </form>
              <div className="auth-switch">
                {signup ? "Already have an account?" : "New to Phoenix Cloud?"}{" "}
                <Link to={signup ? "/login" : "/signup"} search={{ redirect: redirectTo }}>
                  {signup ? "Log in" : "Create an account"}
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
      <p className="auth-footnote">Your next idea starts here.</p>
    </div>
  );
}
