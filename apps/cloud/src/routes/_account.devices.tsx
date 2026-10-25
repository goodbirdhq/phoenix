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
      setError("Couldn't remove this registration. Please try again.");
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
              Your desktop and remote server installations will appear here when device linking is
              available.
            </EmptyDescription>
          </EmptyHeader>
          <span className="coming-soon">Device linking is coming later</span>
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
                    <p>{device.kind === "desktop" ? "Desktop" : "Remote server"} · Not connected</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${device.name}`}
                    onClick={() => setDeleting(device.id)}
                  >
                    <Trash2 />
                  </Button>
                  <DeleteDialog
                    open={deleting === device.id}
                    busy={busy}
                    title={`Remove “${device.name}”?`}
                    description="This removes the device from your account. Your installation will stay on its machine."
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
          Device linking and remote connections are coming later. Registering a device does not
          connect it to Phoenix Cloud.
        </p>
      </aside>
    </>
  );
}
