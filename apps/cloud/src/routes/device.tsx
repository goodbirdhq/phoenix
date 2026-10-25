import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { currentUser, reviewInstallation, decideInstallation } from "~/server/functions";
import { useAppForm } from "~/lib/form";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Brand } from "~/components/brand";

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : "",
  }),
  loader: () => currentUser(),
  component: DeviceApproval,
});
function DeviceApproval() {
  const user = Route.useLoaderData();
  const { user_code } = Route.useSearch();
  const [request, setRequest] = useState<Awaited<ReturnType<typeof reviewInstallation>> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useAppForm({
    defaultValues: { code: user_code },
    onSubmit: async ({ value }) => {
      setError("");
      try {
        setRequest(await reviewInstallation({ data: value.code }));
      } catch {
        setError("This code is invalid, expired, already used, or belongs to another account.");
      }
    },
  });
  async function decide(approve: boolean) {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await decideInstallation({ data: { userCode: request.userCode, approve } });
      setDone(
        approve
          ? "Installation authorized. Return to your machine to finish signing in."
          : "Request denied. No access was granted.",
      );
    } catch {
      setError(
        "This request could not be completed. The code may have expired or already been used.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <header>
        <Brand />
        <Link to="/devices">Devices</Link>
      </header>
      <main className="auth-layout">
        <Card>
          <CardContent>
            <div className="auth-content">
              <h1>Connect an installation</h1>
              {done ? (
                <p role="status">{done}</p>
              ) : !user ? (
                <>
                  <p>
                    Sign in to approve your desktop or remote server. Keep the code displayed on
                    your machine.
                  </p>
                  <Link
                    to="/login"
                    search={{ redirect: `/device?user_code=${encodeURIComponent(user_code)}` }}
                  >
                    Log in
                  </Link>
                  <Link
                    to="/signup"
                    search={{ redirect: `/device?user_code=${encodeURIComponent(user_code)}` }}
                  >
                    Create an account
                  </Link>
                </>
              ) : request ? (
                <>
                  <p>Signed in as {user.email}</p>
                  <h2>{request.name}</h2>
                  <p>{request.kind === "desktop" ? "Desktop" : "Remote server"}</p>
                  <p>
                    Installation identity: <code>{request.installationId}</code>
                  </p>
                  <p>
                    Confirm this code matches your machine: <strong>{request.userCode}</strong>
                  </p>
                  <p>
                    Allow this installation to identify itself to Phoenix Cloud and report when it
                    was last seen. You can revoke access in Devices.
                  </p>
                  <p>
                    Only approve a machine you control. Never approve an unexpected request or a
                    code sent by someone else.
                  </p>
                  <Button disabled={busy} onClick={() => void decide(true)}>
                    Approve installation
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                    Deny
                  </Button>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                  }}
                >
                  <p>Enter the code shown by Phoenix on your machine.</p>
                  <form.AppField name="code">
                    {(field) => (
                      <field.TextField
                        label="Device code"
                        required
                        autoComplete="off"
                        maxLength={32}
                      />
                    )}
                  </form.AppField>
                  <form.Subscribe selector={(state) => state.isSubmitting}>
                    {(submitting) => (
                      <Button type="submit" disabled={submitting}>
                        Review installation
                      </Button>
                    )}
                  </form.Subscribe>
                </form>
              )}
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
