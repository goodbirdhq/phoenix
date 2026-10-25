import { useState } from "react";
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Folder, LogOut, Monitor } from "lucide-react";
import { currentUser } from "~/server/functions";
import { authClient } from "~/lib/auth-client";
import { Brand } from "~/components/brand";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_account")({
  beforeLoad: async () => {
    const user = await currentUser();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AccountLayout,
});
function AccountLayout() {
  const { user } = Route.useRouteContext();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError("Couldn't log out. Please try again.");
        return;
      }
      window.location.assign("/login");
    } catch {
      setError("Couldn't log out. Check your connection.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-shell">
      <aside className="sidebar">
        <Brand />
        <span className="nav-caption">YOUR ACCOUNT</span>
        <nav>
          <Link to="/dashboard" activeProps={{ className: "active" }}>
            <Folder size={18} /> Workspaces
          </Link>
          <Link to="/devices" activeProps={{ className: "active" }}>
            <Monitor size={18} /> Devices
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          <div className="account-person">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Log out"
            disabled={busy}
            onClick={() => void logout()}
          >
            <LogOut size={17} />
          </Button>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </aside>
      <main className="account-main">
        <Outlet />
      </main>
    </div>
  );
}
