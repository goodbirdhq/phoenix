import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  currentUser,
  reviewInstallation,
  decideInstallation,
  reviewBrowserInstallation,
  decideBrowserInstallation,
} from "~/server/functions";
import { deviceSearch } from "~/lib/oauth-search";
import { useAppForm } from "~/lib/form";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Brand } from "~/components/brand";

export const Route = createFileRoute("/device")({
  validateSearch: deviceSearch,
  loader: async ({ location }) => ({
    user: await currentUser(),
    // Preserve signed parameters byte-for-byte; search validation can coerce numeric values.
    oauthQuery: new URLSearchParams(location.searchStr).has("client_id")
      ? location.searchStr.slice(1)
      : "",
  }),
  component: () => (Route.useLoaderData().oauthQuery ? <BrowserApproval /> : <DeviceApproval />),
});
function DeviceApproval() {
  const { user } = Route.useLoaderData();
  const { user_code = "" } = Route.useSearch();
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
                  <p>This name and type are reported by the installation.</p>
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

function BrowserApproval() {
  const { user } = Route.useLoaderData();
  const { oauthQuery } = Route.useLoaderData();
  const [request, setRequest] = useState<Awaited<
    ReturnType<typeof reviewBrowserInstallation>
  > | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void reviewBrowserInstallation({ data: new URLSearchParams(oauthQuery).get("client_id") ?? "" })
      .then((value) => {
        if (active) setRequest(value);
      })
      .catch(() => {
        if (active)
          setError("This request is invalid or expired. Return to Phoenix and try again.");
      });
    return () => {
      active = false;
    };
  }, [user, oauthQuery]);
  async function decide(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await decideBrowserInstallation({ data: { oauthQuery, approve } });
      window.location.assign(result.url);
    } catch {
      setError("This request could not be completed. Return to Phoenix and start again.");
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <header>
        <Brand />
      </header>
      <main className="auth-layout">
        <Card>
          <CardContent>
            <div className="auth-content">
              <h1>Connect an installation</h1>
              {!user ? (
                <>
                  <p>Sign in to approve your Phoenix installation.</p>
                  <Link to="/login" search={{ redirect: `/device?${oauthQuery}` }}>
                    Log in
                  </Link>
                  <Link to="/signup" search={{ redirect: `/device?${oauthQuery}` }}>
                    Create an account
                  </Link>
                </>
              ) : request ? (
                <>
                  <p>Signed in as {user.email}</p>
                  <h2>{request.name}</h2>
                  <p>{request.kind === "desktop" ? "Desktop" : "Remote server"}</p>
                  <p>This name and type are reported by the installation.</p>
                  <p>
                    Installation identity: <code>{request.installationId}</code>
                  </p>
                  <p>Return to: {request.callback}</p>
                  <p>
                    Allow this installation to identify itself to Phoenix Cloud and report when it
                    was last seen. You can revoke access in Devices.
                  </p>
                  <p>Only approve a machine you control.</p>
                  <Button disabled={busy} onClick={() => void decide(true)}>
                    Approve installation
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                    Deny
                  </Button>
                </>
              ) : !error ? (
                <p>Loading installation…</p>
              ) : null}
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
