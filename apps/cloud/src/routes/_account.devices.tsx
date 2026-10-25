import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Monitor, Server, Trash2 } from "lucide-react";
import { listInstallations, deleteInstallation } from "~/server/functions";
import { DeleteDialog } from "~/components/delete-dialog";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "~/components/ui/empty";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_account/devices")({
  loader: () => listInstallations(),
  component: Devices,
});
function Devices() {
  const devices = Route.useLoaderData();
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await deleteInstallation({ data: { id } });
      await router.invalidate();
      setDeleting(null);
    } catch {
      setError("Couldn't remove this device access. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-topline">
        <span>YOUR INSTALLATIONS</span>
        <span className="cloud-badge">Phoenix Cloud</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>Devices</h1>
          <p>The machines you build on, in one place.</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="section-label">
        <span>REGISTERED DEVICES</span>
        <span>
          {devices.length} {devices.length === 1 ? "device" : "devices"}
        </span>
      </div>
      {devices.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Monitor />
            </EmptyMedia>
            <EmptyTitle>No devices registered yet</EmptyTitle>
            <EmptyDescription>
              Sign in to Phoenix Cloud from your desktop app or run phoenix cloud login on a remote
              server.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="device-list">
          {devices.map((device) => (
            <Card key={device.id}>
              <CardContent>
                <div className="device-row">
                  {device.kind === "desktop" ? <Monitor /> : <Server />}
                  <div>
                    <h2>{device.name}</h2>
                    <p>
                      {device.kind === "desktop" ? "Desktop" : "Remote server"} ·{" "}
                      {device.revokedAt
                        ? "Disconnected"
                        : device.lastSeenAt
                          ? "Authorized"
                          : "Awaiting first contact"}
                    </p>
                    <p>
                      {device.lastSeenAt
                        ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                        : "No heartbeat received"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Disconnect ${device.name}`}
                    disabled={Boolean(device.revokedAt)}
                    onClick={() => setDeleting(device.id)}
                  >
                    <Trash2 />
                  </Button>
                  <DeleteDialog
                    actionLabel="Disconnect"
                    busyLabel="Disconnecting…"
                    open={deleting === device.id}
                    busy={busy}
                    title={`Disconnect “${device.name}”?`}
                    description="This revokes this installation’s Cloud access immediately. Local projects and agents stay on its machine."
                    onClose={() => setDeleting(null)}
                    onConfirm={() => void remove(device.id)}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <aside className="info-note">
        <Server size={18} />
        <p>
          Cloud sign-in identifies your installations. Last seen records their latest heartbeat; it
          does not mean a remote connection is available.
        </p>
      </aside>
    </>
  );
}
